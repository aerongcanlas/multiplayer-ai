import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { Journal } from "../journal";
import { SupervisorService } from "../service";
import { inspectWorkspace } from "../workspace";
import { HarnessRegistry } from "../harnesses/registry";
import { FakeHarness } from "../harnesses/fake";
import { ProgramManager } from "../programs/manager";
import { HARNESS_MANIFEST } from "../programs/manifest";
import type { SupervisorRequest } from "../../shared/contracts";
import type { Tab, TranscriptBatch, TranscriptEntry } from "../../shared/tabs";

async function repository() {
  const dir = await mkdtemp(join(tmpdir(), "multiplayer-tabs-"));
  const repo = join(dir, "repo");
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--allow-empty",
    "-m",
    "Fixture",
  );
  // The fake harness runs as a custom executable, so nothing is downloaded.
  const executable = join(dir, "fake-harness");
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);
  return { dir, repo, executable };
}

type Setup = Awaited<ReturnType<typeof start>>;
async function start(
  fake: FakeHarness,
  paths?: { dir: string; repo: string; executable: string },
) {
  const { dir, repo, executable } = paths ?? (await repository());
  const journal = new Journal(join(dir, "journal.sqlite"));
  journal.setSetting(`harness.${fake.id}.executable`, executable);
  const batches: TranscriptBatch[] = [];
  let changed = () => {};
  const registry = new HarnessRegistry({
    adapters: [fake],
    programs: new ProgramManager({ root: dir, manifest: HARNESS_MANIFEST }),
    settings: journal,
    changed: () => changed(),
    environmentTimeoutMs: 0,
  });
  registry.setEnvironment({ PATH: process.env.PATH ?? "" });
  const service = new SupervisorService(journal, () => {}, {
    registry,
    publishTranscript: (items) => batches.push(...items),
    transcriptInterval: 5,
    stopTimeoutMs: 300,
  });
  changed = () => service.harnessesChanged();
  await registry.refresh(fake.id);
  const roomId = service.snapshot().rooms[0].id;
  if (!paths)
    await service.dispatch({
      type: "workspace.register",
      roomId,
      workspace: await inspectWorkspace(repo),
    });
  const dispatch = (command: SupervisorRequest["command"]) =>
    service.dispatchResult(command);
  const tabs = () => service.snapshot().rooms[0].tabs;
  const tab = (id: string) => tabs().find((tab) => tab.id === id)!;
  const open = async () => {
    await dispatch({ type: "tab.open", roomId, harness: fake.id });
    return tabs().at(-1)!;
  };
  const transcript = async (tabId: string): Promise<TranscriptEntry[]> =>
    (await dispatch({ type: "tab.transcript", roomId, tabId })).transcript!
      .entries;
  const until = async (
    check: () => boolean | Promise<boolean>,
    label: string,
  ) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await check()) return;
      await wait(10);
    }
    throw new Error(`Timed out waiting for ${label}.`);
  };
  const settled = (tabId: string) =>
    until(
      () => !["running", "awaiting_host"].includes(tab(tabId).status),
      "turn end",
    );
  const send = (
    tabId: string,
    text: string,
    extra: Record<string, unknown> = {},
  ) =>
    dispatch({
      type: "tab.send",
      roomId,
      tabId,
      text,
      ...extra,
    } as SupervisorRequest["command"]);
  return {
    dir,
    repo,
    executable,
    journal,
    service,
    registry,
    batches,
    roomId,
    dispatch,
    tabs,
    tab,
    open,
    transcript,
    until,
    settled,
    send,
    close: () => service.close(),
  };
}

const pendingOf = async (setup: Setup, tabId: string, kind: string) => {
  let found: TranscriptEntry | undefined;
  await setup.until(async () => {
    found = (await setup.transcript(tabId)).find(
      (entry) => entry.kind === kind && entry.state === "pending",
    );
    return Boolean(found);
  }, `pending ${kind}`);
  return found!;
};

test("a send streams deltas into one assistant entry and ends the turn idle", async () => {
  const fake = new FakeHarness();
  const setup = await start(fake);
  try {
    const tab = await setup.open();
    assert.equal(tab.status, "idle");
    assert.equal(tab.loadout.model, "fake-model");
    assert.equal(tab.loadout.effort, "medium");
    await setup.send(tab.id, "Hello there");
    assert.equal(setup.tab(tab.id).status, "running");
    await setup.settled(tab.id);
    assert.equal(setup.tab(tab.id).status, "idle");
    const entries = await setup.transcript(tab.id);
    assert.deepEqual(
      entries.map((entry) => entry.kind),
      ["user", "reasoning", "assistant", "turn"],
    );
    assert.equal(entries[2].summary, "Hello!");
    assert.deepEqual(
      entries.map((entry) => entry.seq),
      [1, 2, 3, 4],
    );
    assert.equal(entries[3].outcome, "completed");
    assert.ok(setup.tab(tab.id).sessionId);
    assert.ok(setup.batches.some((batch) => batch.tabId === tab.id));
    // Share levels: reasoning is never shared.
    assert.equal(entries[1].share, "none");
    assert.equal(entries[2].share, "full");
  } finally {
    setup.close();
  }
});

test("an approval waits on the host and accepting it continues the turn", async () => {
  const fake = new FakeHarness();
  const setup = await start(fake);
  try {
    const tab = await setup.open();
    await setup.send(tab.id, "FAKE_APPROVAL please");
    const approval = await pendingOf(setup, tab.id, "approval");
    assert.equal(setup.tab(tab.id).status, "awaiting_host");
    assert.equal(approval.share, "summary");
    await setup.dispatch({
      type: "approval.respond",
      roomId: setup.roomId,
      tabId: tab.id,
      approvalId: approval.id,
      decision: "accept",
    });
    await setup.settled(tab.id);
    const entries = await setup.transcript(tab.id);
    assert.equal(
      entries.find((entry) => entry.id === approval.id)?.state,
      "accepted",
    );
    const tool = entries.find((entry) => entry.kind === "tool")!;
    // Tool output stays local; only the one-line summary is shareable.
    assert.equal(tool.summary, "git status");
    assert.equal(tool.detail, "nothing to commit");
    assert.equal(tool.share, "summary");
    assert.ok(fake.calls.includes("respond:approval-1:accept"));
    await assert.rejects(
      setup.dispatch({
        type: "approval.respond",
        roomId: setup.roomId,
        tabId: tab.id,
        approvalId: approval.id,
        decision: "accept",
      }),
      /no longer pending/,
    );
  } finally {
    setup.close();
  }
});

test("a question card's answer reaches the harness", async () => {
  const fake = new FakeHarness("claude", { signIn: "guidance" });
  const setup = await start(fake);
  try {
    const tab = await setup.open();
    await setup.send(tab.id, "FAKE_QUESTION run the skill");
    const question = await pendingOf(setup, tab.id, "question");
    assert.equal(question.questions?.[0].id, "scope");
    await assert.rejects(
      setup.dispatch({
        type: "question.answer",
        roomId: setup.roomId,
        tabId: tab.id,
        questionId: question.id,
        answers: { unknown: ["x"] },
      }),
      /do not match/,
    );
    await setup.dispatch({
      type: "question.answer",
      roomId: setup.roomId,
      tabId: tab.id,
      questionId: question.id,
      answers: { scope: ["Small"] },
    });
    await setup.settled(tab.id);
    const entries = await setup.transcript(tab.id);
    assert.equal(
      entries.find((entry) => entry.id === question.id)?.state,
      "answered",
    );
    assert.match(
      entries.find((entry) => entry.kind === "assistant")!.summary,
      /Small/,
    );
    assert.ok(fake.calls.includes("answer:question-1"));
  } finally {
    setup.close();
  }
});

test("Stop during a pending approval cancels it before stopping, and the turn ends stopped", async () => {
  const fake = new FakeHarness();
  const setup = await start(fake);
  try {
    const tab = await setup.open();
    await setup.send(tab.id, "FAKE_APPROVAL please");
    const approval = await pendingOf(setup, tab.id, "approval");
    await setup.dispatch({
      type: "tab.stop",
      roomId: setup.roomId,
      tabId: tab.id,
    });
    await setup.settled(tab.id);
    assert.equal(setup.tab(tab.id).status, "idle");
    assert.deepEqual(
      fake.calls.filter((call) => call.startsWith("cancel") || call === "stop"),
      ["cancel:approval-1", "stop"],
    );
    const entries = await setup.transcript(tab.id);
    assert.equal(
      entries.find((entry) => entry.id === approval.id)?.state,
      "cancelled",
    );
    assert.equal(entries.at(-1)?.outcome, "stopped");
  } finally {
    setup.close();
  }
});

test("after a restart a running turn is interrupted with no pending approval, and a follow-up resumes the session", async () => {
  const fake = new FakeHarness();
  const first = await start(fake);
  const tab = await first.open();
  await first.send(tab.id, "Hello");
  await first.settled(tab.id);
  const sessionId = first.tab(tab.id).sessionId!;
  await first.send(tab.id, "FAKE_APPROVAL please");
  await pendingOf(first, tab.id, "approval");
  first.close();

  const second = await start(fake, first);
  try {
    const restored = second.tab(tab.id);
    assert.equal(restored.status, "interrupted");
    const entries = await second.transcript(tab.id);
    assert.equal(
      entries.filter((entry) => entry.state === "pending").length,
      0,
    );
    assert.equal(
      entries.find((entry) => entry.kind === "approval")?.state,
      "cancelled",
    );
    assert.equal(entries.at(-1)?.notice, "interrupted");
    // AE5: the follow-up reopens the stored session.
    await second.send(tab.id, "Continue");
    await second.settled(tab.id);
    assert.ok(fake.calls.includes(`open:${sessionId}`));
    assert.equal(second.tab(tab.id).status, "idle");
    assert.equal(second.tab(tab.id).sessionId, sessionId);
  } finally {
    second.close();
  }
});

test("turns are one per tab, concurrent across tabs, and lock the loadout", async () => {
  const fake = new FakeHarness();
  const setup = await start(fake);
  try {
    const one = await setup.open();
    const two = await setup.open();
    assert.equal(two.title, "Codex 2");
    await setup.send(one.id, "FAKE_SLOW");
    await setup.send(two.id, "FAKE_SLOW");
    assert.equal(setup.tab(one.id).status, "running");
    assert.equal(setup.tab(two.id).status, "running");
    await assert.rejects(setup.send(one.id, "Again"), /already running/);
    await assert.rejects(
      setup.dispatch({
        type: "tab.setLoadout",
        roomId: setup.roomId,
        tabId: one.id,
        loadout: { ...one.loadout, planMode: true },
      }),
      /after this turn ends/,
    );
    await setup.dispatch({
      type: "tab.stop",
      roomId: setup.roomId,
      tabId: one.id,
    });
    await setup.dispatch({
      type: "tab.stop",
      roomId: setup.roomId,
      tabId: two.id,
    });
    await setup.settled(one.id);
    await setup.settled(two.id);
  } finally {
    setup.close();
  }
});

test("a model missing from the latest list blocks send until reselected", async () => {
  const fake = new FakeHarness();
  const setup = await start(fake);
  try {
    const tab = await setup.open();
    fake.models = [
      {
        id: "other",
        name: "Other",
        efforts: [],
        defaultEffort: null,
        isDefault: true,
      },
    ];
    await setup.registry.refresh("codex");
    await assert.rejects(setup.send(tab.id, "Hello"), /Choose a model again/);
    await setup.dispatch({
      type: "tab.setLoadout",
      roomId: setup.roomId,
      tabId: tab.id,
      loadout: {
        harness: "codex",
        model: "other",
        planMode: false,
        access: "ask",
      },
    });
    await setup.send(tab.id, "Hello");
    await setup.settled(tab.id);
    assert.equal(fake.loadouts.at(-1)?.model, "other");
  } finally {
    setup.close();
  }
});

test("a suggestion is validated, stored on the user entry, and marked submitted in a local room", async () => {
  const fake = new FakeHarness();
  const setup = await start(fake);
  try {
    const tab = await setup.open();
    await setup.dispatch({
      type: "message.send",
      roomId: setup.roomId,
      text: "Add dark mode",
    });
    const message = setup.service.snapshot().rooms[0].messages[0];
    await setup.dispatch({
      type: "suggestion.create",
      roomId: setup.roomId,
      messageIds: [message.id],
    });
    const suggestion = setup.service.snapshot().rooms[0].suggestions[0];
    await assert.rejects(
      setup.send(tab.id, suggestion.prompt, {
        suggestionId: suggestion.id,
        suggestionRevision: 2,
      }),
      /suggestion changed/,
    );
    await setup.send(tab.id, suggestion.prompt, {
      suggestionId: suggestion.id,
      suggestionRevision: 1,
    });
    await setup.settled(tab.id);
    const user = (await setup.transcript(tab.id))[0];
    assert.equal(user.source?.suggestionId, suggestion.id);
    assert.equal(user.source?.sources[0].text, "Add dark mode");
    assert.equal(
      setup.service.snapshot().rooms[0].suggestions[0].status,
      "submitted",
    );
    await assert.rejects(
      setup.send(tab.id, suggestion.prompt, {
        suggestionId: suggestion.id,
        suggestionRevision: 1,
      }),
      /already submitted/,
    );
  } finally {
    setup.close();
  }
});

test("closing a running tab needs confirmation, then stops the turn and removes the tab", async () => {
  const fake = new FakeHarness();
  const setup = await start(fake);
  try {
    const tab = await setup.open();
    await setup.send(tab.id, "FAKE_SLOW");
    await setup.until(
      () => fake.calls.includes("send:FAKE_SLOW"),
      "turn start",
    );
    await assert.rejects(
      setup.dispatch({
        type: "tab.close",
        roomId: setup.roomId,
        tabId: tab.id,
      }),
      /Confirm/,
    );
    await setup.dispatch({
      type: "tab.close",
      roomId: setup.roomId,
      tabId: tab.id,
      confirm: true,
    });
    assert.equal(setup.tabs().length, 0);
    assert.ok(fake.calls.includes("stop"));
    assert.ok(fake.calls.includes("close"));
    assert.equal(setup.journal.lastSeq(tab.id), 0);
  } finally {
    setup.close();
  }
});

test("a harness failure mid-turn ends the turn with an error entry", async () => {
  const fake = new FakeHarness();
  const setup = await start(fake);
  try {
    const tab = await setup.open();
    await setup.send(tab.id, "FAKE_THROW");
    await setup.settled(tab.id);
    assert.equal(setup.tab(tab.id).status, "error");
    const entries = await setup.transcript(tab.id);
    assert.equal(
      entries.find((entry) => entry.kind === "error")?.summary,
      "Fake failure.",
    );
    assert.equal(entries.at(-1)?.outcome, "failed");
    // The next send recovers from the error state.
    await setup.send(tab.id, "Hello");
    await setup.settled(tab.id);
    assert.equal(setup.tab(tab.id).status, "idle");

    await setup.send(tab.id, "FAKE_USAGE");
    await setup.settled(tab.id);
    const usage = (await setup.transcript(tab.id)).find(
      (entry) => entry.notice === "usage_limit",
    );
    assert.equal(usage?.resetsAt, 2_000_000_000);
  } finally {
    setup.close();
  }
});

test("a session that cannot be resumed offers a fresh session", async () => {
  const fake = new FakeHarness();
  const first = await start(fake);
  const tab = await first.open();
  await first.send(tab.id, "Hello");
  await first.settled(tab.id);
  first.close();
  fake.resumable = false;
  const second = await start(fake, first);
  try {
    await second.send(tab.id, "Continue");
    await second.settled(tab.id);
    assert.equal(second.tab(tab.id).status, "resume_failed");
    const notice = (await second.transcript(tab.id)).find(
      (entry) => entry.notice === "resume_failed",
    );
    assert.equal(notice?.offerFreshSession, true);
    await assert.rejects(second.send(tab.id, "Again"), /Start a fresh session/);
    await second.dispatch({
      type: "tab.resetSession",
      roomId: second.roomId,
      tabId: tab.id,
    });
    assert.equal(second.tab(tab.id).sessionId, undefined);
    await second.send(tab.id, "Fresh start");
    await second.settled(tab.id);
    assert.equal(second.tab(tab.id).status, "idle");
    assert.equal(fake.calls.at(-1)?.startsWith("send:Fresh"), true);
  } finally {
    second.close();
  }
});

test("a failed first turn after a resume also offers a fresh session", async () => {
  const fake = new FakeHarness();
  const first = await start(fake);
  const tab = await first.open();
  await first.send(tab.id, "Hello");
  await first.settled(tab.id);
  first.close();
  fake.failFirstResumedTurn = true;
  const second = await start(fake, first);
  try {
    await second.send(tab.id, "Continue");
    await second.settled(tab.id);
    const error = (await second.transcript(tab.id)).find(
      (entry) => entry.kind === "error",
    );
    assert.equal(error?.offerFreshSession, true);
  } finally {
    second.close();
  }
});

test("Stop answers while a slow harness refresh is still running", async () => {
  const fake = new FakeHarness("codex", { inspectDelayMs: 1_000 });
  const setup = await start(fake);
  try {
    const tab = await setup.open();
    await setup.send(tab.id, "FAKE_SLOW");
    const began = Date.now();
    await setup.dispatch({ type: "harness.refresh", harness: "codex" });
    await setup.dispatch({
      type: "tab.stop",
      roomId: setup.roomId,
      tabId: tab.id,
    });
    assert.ok(Date.now() - began < 500);
    await setup.settled(tab.id);
    assert.equal(setup.tab(tab.id).status, "idle");
  } finally {
    setup.close();
  }
});

test("a sign-out mid-turn yields a sign-out notice and marks the harness not ready", async () => {
  const fake = new FakeHarness();
  const setup = await start(fake);
  try {
    const tab = await setup.open();
    await setup.send(tab.id, "FAKE_SIGNOUT");
    await setup.settled(tab.id);
    const entries = await setup.transcript(tab.id);
    assert.equal(
      entries.some((entry) => entry.kind === "error"),
      false,
    );
    assert.equal(
      entries.find((entry) => entry.notice === "signed_out")?.kind,
      "notice",
    );
    assert.equal(setup.tab(tab.id).status, "unavailable");
    assert.equal(
      setup.service
        .snapshot()
        .harnesses?.find((harness) => harness.id === "codex")?.auth.state,
      "signed_out",
    );
    await assert.rejects(setup.send(tab.id, "Hello"), /not ready/);
  } finally {
    setup.close();
  }
});

test("plan mode marks the plan continuable, and continuing turns plan mode off", async () => {
  const fake = new FakeHarness();
  const setup = await start(fake);
  try {
    const tab = await setup.open();
    await setup.dispatch({
      type: "tab.setLoadout",
      roomId: setup.roomId,
      tabId: tab.id,
      loadout: { ...setup.tab(tab.id).loadout, planMode: true },
    });
    await setup.send(tab.id, "Plan the change");
    await setup.settled(tab.id);
    const plan = (await setup.transcript(tab.id)).find(
      (entry) => entry.kind === "plan",
    );
    assert.equal(plan?.continuable, true);
    await setup.send(tab.id, "Implement the plan.", { continuePlan: true });
    await setup.settled(tab.id);
    assert.equal(setup.tab(tab.id).loadout.planMode, false);
    assert.equal(fake.loadouts.at(-1)?.planMode, false);

    // A harness that asks to leave plan mode gets a continue card instead.
    await setup.dispatch({
      type: "tab.setLoadout",
      roomId: setup.roomId,
      tabId: tab.id,
      loadout: { ...setup.tab(tab.id).loadout, planMode: true },
    });
    await setup.send(tab.id, "FAKE_EXIT_PLAN");
    const exit = await pendingOf(setup, tab.id, "plan");
    await setup.dispatch({
      type: "approval.respond",
      roomId: setup.roomId,
      tabId: tab.id,
      approvalId: exit.id,
      decision: "accept",
    });
    await setup.settled(tab.id);
    assert.equal(setup.tab(tab.id).loadout.planMode, false);
  } finally {
    setup.close();
  }
});

test("changing the harness between turns starts a new session", async () => {
  const codex = new FakeHarness("codex");
  const setup = await start(codex);
  try {
    const tab: Tab = await setup.open();
    await setup.send(tab.id, "Hello");
    await setup.settled(tab.id);
    await assert.rejects(
      setup.dispatch({
        type: "tab.setLoadout",
        roomId: setup.roomId,
        tabId: tab.id,
        loadout: { ...tab.loadout, effort: "xhigh" },
      }),
      /does not support/,
    );
    await setup.dispatch({
      type: "tab.rename",
      roomId: setup.roomId,
      tabId: tab.id,
      title: "Refactor",
    });
    assert.equal(setup.tab(tab.id).title, "Refactor");
  } finally {
    setup.close();
  }
});

test("a shared-room import keeps local tabs for the same account and project", async () => {
  const fake = new FakeHarness();
  const setup = await start(fake);
  try {
    const shared = {
      ...structuredClone(setup.service.snapshot().rooms[0]),
      id: randomUUID(),
      workspace: null,
      tabs: [],
      shared: {
        userId: randomUUID(),
        project: "test",
        isAdmin: true,
        members: [],
      },
    };
    await setup.dispatch({ type: "shared.import", room: shared });
    await setup.dispatch({
      type: "tab.open",
      roomId: shared.id,
      harness: "codex",
    });
    const room = () =>
      setup.service.snapshot().rooms.find((item) => item.id === shared.id)!;
    const tabId = room().tabs[0].id;
    await setup.dispatch({
      type: "shared.import",
      room: { ...shared, name: "Renamed" },
    });
    assert.equal(room().name, "Renamed");
    assert.equal(room().tabs[0].id, tabId);
    await setup.dispatch({
      type: "shared.import",
      room: { ...shared, shared: { ...shared.shared, userId: randomUUID() } },
    });
    assert.deepEqual(room().tabs, []);
  } finally {
    setup.close();
  }
});
