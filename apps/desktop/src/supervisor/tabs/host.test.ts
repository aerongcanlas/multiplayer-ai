import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { FakeHarness } from "../harnesses/fake";
import { start, withHost } from "../test-support";
import { inspectWorkspace } from "../workspace";
import type { Tab } from "../../shared/tabs";

test("a send streams deltas into one assistant entry and ends the turn idle", () =>
  withHost(async (setup) => {
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
  }));

test("an approval waits on the host and accepting it continues the turn", () =>
  withHost(async (setup, fake) => {
    const tab = await setup.open();
    await setup.send(tab.id, "FAKE_APPROVAL please");
    const approval = await setup.pending(tab.id, "approval");
    assert.equal(setup.tab(tab.id).status, "awaiting_host");
    assert.equal(approval.share, "summary");
    await setup.respond(tab.id, approval.id);
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
      setup.respond(tab.id, approval.id),
      /no longer pending/,
    );
  }));

test("a question card's answer reaches the harness", () =>
  withHost({ id: "claude", signIn: "guidance" }, async (setup, fake) => {
    const tab = await setup.open();
    await setup.send(tab.id, "FAKE_QUESTION run the skill");
    const question = await setup.pending(tab.id, "question");
    assert.equal(question.questions?.[0].id, "scope");
    await assert.rejects(
      setup.answer(tab.id, question.id, { unknown: ["x"] }),
      /do not match/,
    );
    await setup.answer(tab.id, question.id, { scope: ["Small"] });
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
  }));

test("Stop during a pending approval cancels it before stopping, and the turn ends stopped", () =>
  withHost(async (setup, fake) => {
    const tab = await setup.open();
    await setup.send(tab.id, "FAKE_APPROVAL please");
    const approval = await setup.pending(tab.id, "approval");
    await setup.stopTab(tab.id);
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
  }));

test("after a restart a running turn is interrupted with no pending approval, and a follow-up resumes the session", async () => {
  const fake = new FakeHarness();
  const first = await start(fake);
  const tab = await first.open();
  await first.send(tab.id, "Hello");
  await first.settled(tab.id);
  const sessionId = first.tab(tab.id).sessionId!;
  await first.send(tab.id, "FAKE_APPROVAL please");
  await first.pending(tab.id, "approval");
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
    // The follow-up reopens the stored session.
    await second.send(tab.id, "Continue");
    await second.settled(tab.id);
    assert.ok(fake.calls.includes(`open:${sessionId}`));
    assert.equal(second.tab(tab.id).status, "idle");
    assert.equal(second.tab(tab.id).sessionId, sessionId);
  } finally {
    second.close();
  }
});

test("turns are one per tab, concurrent across tabs, and lock the loadout", () =>
  withHost(async (setup) => {
    const one = await setup.open();
    const two = await setup.open();
    assert.equal(two.title, "Codex 2");
    await setup.send(one.id, "FAKE_SLOW");
    await setup.send(two.id, "FAKE_SLOW");
    assert.equal(setup.tab(one.id).status, "running");
    assert.equal(setup.tab(two.id).status, "running");
    await assert.rejects(setup.send(one.id, "Again"), /already running/);
    await assert.rejects(
      setup.setLoadout(one.id, { ...one.loadout, planMode: true }),
      /after this turn ends/,
    );
    await setup.stopTab(one.id);
    await setup.stopTab(two.id);
    await setup.settled(one.id);
    await setup.settled(two.id);
  }));

test("a model missing from the latest list blocks send until reselected", () =>
  withHost(async (setup, fake) => {
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
    await setup.setLoadout(tab.id, {
      harness: "codex",
      model: "other",
      planMode: false,
      access: "ask",
    });
    await setup.send(tab.id, "Hello");
    await setup.settled(tab.id);
    assert.equal(fake.loadouts.at(-1)?.model, "other");
  }));

test("a suggestion is validated, stored on the user entry, and marked submitted in a local room", () =>
  withHost(async (setup) => {
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
  }));

test("closing a running tab needs confirmation, then stops the turn and keeps the chat closed", () =>
  withHost(async (setup, fake) => {
    const tab = await setup.open();
    await setup.send(tab.id, "FAKE_SLOW");
    await setup.until(
      () => fake.calls.includes("send:FAKE_SLOW"),
      "turn start",
    );
    await assert.rejects(setup.closeTab(tab.id), /Confirm/);
    await setup.closeTab(tab.id, true);
    assert.equal(setup.tabs().length, 0);
    assert.ok(fake.calls.includes("stop"));
    assert.ok(fake.calls.includes("close"));
    const room = setup.service.snapshot().rooms[0];
    assert.equal(room.closedTabs?.[0].id, tab.id);
    assert.ok(room.closedTabs?.[0].closedAt);
    assert.equal(room.closedTabs?.[0].status, "interrupted");
    assert.ok(setup.journal.lastSeq(tab.id) > 0);
  }));

test("a closed chat survives a restart and reopens with its transcript and session", async () => {
  const fake = new FakeHarness("codex");
  const setup = await start(fake);
  let tabId = "";
  let before = 0;
  try {
    const tab = await setup.open();
    tabId = tab.id;
    await setup.send(tab.id, "Hello there");
    await setup.settled(tab.id);
    before = (await setup.transcript(tab.id)).length;
    await setup.closeTab(tab.id);
    assert.deepEqual(setup.tabs(), []);
  } finally {
    setup.close();
  }
  const restarted = await start(new FakeHarness("codex"), setup);
  try {
    const room = () => restarted.service.snapshot().rooms[0];
    assert.equal(room().closedTabs?.[0].id, tabId);
    await restarted.dispatch({
      type: "tab.reopen",
      roomId: restarted.roomId,
      tabId,
    });
    assert.deepEqual(room().closedTabs, []);
    const reopened = restarted.tab(tabId);
    assert.equal(reopened.closedAt, undefined);
    assert.ok(reopened.sessionId);
    // A reopened chat is private until the host shares it again.
    assert.equal(reopened.readAlong, false);
    assert.deepEqual(reopened.readAlongWindows, []);
    assert.equal((await restarted.transcript(tabId)).length, before);
    await assert.rejects(
      restarted.dispatch({
        type: "tab.reopen",
        roomId: restarted.roomId,
        tabId,
      }),
      /no longer in this room's history/,
    );
  } finally {
    restarted.close();
  }
});

test("a harness failure mid-turn ends the turn with an error entry", () =>
  withHost(async (setup) => {
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
  }));

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
    await second.resetSession(tab.id);
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

test("Stop answers while a slow harness refresh is still running", () =>
  withHost({ inspectDelayMs: 1_000 }, async (setup) => {
    const tab = await setup.open();
    await setup.send(tab.id, "FAKE_SLOW");
    const began = Date.now();
    await setup.dispatch({ type: "harness.refresh", harness: "codex" });
    await setup.stopTab(tab.id);
    assert.ok(Date.now() - began < 500);
    await setup.settled(tab.id);
    assert.equal(setup.tab(tab.id).status, "idle");
  }));

test("a sign-out mid-turn yields a sign-out notice and marks the harness not ready", () =>
  withHost(async (setup) => {
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
  }));

test("plan mode marks the plan continuable, and continuing turns plan mode off", () =>
  withHost(async (setup, fake) => {
    const tab = await setup.open();
    await setup.setLoadout(tab.id, {
      ...setup.tab(tab.id).loadout,
      planMode: true,
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
    await setup.setLoadout(tab.id, {
      ...setup.tab(tab.id).loadout,
      planMode: true,
    });
    await setup.send(tab.id, "FAKE_EXIT_PLAN");
    const exit = await setup.pending(tab.id, "plan");
    await setup.respond(tab.id, exit.id);
    await setup.settled(tab.id);
    assert.equal(setup.tab(tab.id).loadout.planMode, false);
  }));

test("changing the harness between turns starts a new session", () =>
  withHost(async (setup) => {
    const tab: Tab = await setup.open();
    await setup.send(tab.id, "Hello");
    await setup.settled(tab.id);
    await assert.rejects(
      setup.setLoadout(tab.id, { ...tab.loadout, effort: "xhigh" }),
      /does not support/,
    );
    await setup.dispatch({
      type: "tab.rename",
      roomId: setup.roomId,
      tabId: tab.id,
      title: "Refactor",
    });
    assert.equal(setup.tab(tab.id).title, "Refactor");
  }));

test("a shared-room import keeps local tabs for the same account and project", () =>
  withHost(async (setup) => {
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
    await setup.dispatch({ type: "tab.close", roomId: shared.id, tabId });
    assert.equal(room().closedTabs?.[0].id, tabId);
    await setup.dispatch({
      type: "shared.import",
      room: { ...shared, shared: { ...shared.shared, userId: randomUUID() } },
    });
    // Another account never sees the previous account's chats, closed ones included.
    assert.deepEqual(room().tabs, []);
    assert.deepEqual(room().closedTabs, []);
    assert.equal(setup.journal.lastSeq(tabId), 0);
  }));

test("restored tabs become ready again without a manual refresh", async () => {
  const fake = new FakeHarness();
  const first = await start(fake);
  const tab = await first.open();
  first.close();
  const before = fake.calls.filter((call) =>
    call.startsWith("inspect:"),
  ).length;
  // `start` refreshes on its own; count only the refresh the service triggers.
  const second = await start(fake, first);
  try {
    await second.until(() => second.tab(tab.id).status === "idle", "ready tab");
    assert.ok(
      fake.calls.filter((call) => call.startsWith("inspect:")).length > before,
    );
  } finally {
    second.close();
  }
});

test("sub-agents get cards under their turn, and a background one outlives the turn without blocking it", () =>
  withHost({ id: "claude", signIn: "guidance" }, async (setup, fake) => {
    const tab = await setup.open();
    await setup.send(tab.id, "FAKE_AGENTS go");
    await setup.settled(tab.id);
    // The tab is idle and accepts messages while the background card runs.
    const idle = setup.tab(tab.id);
    assert.equal(idle.status, "idle");
    assert.equal(idle.runningAgents, 1);
    assert.equal(idle.agentRequests, 1);
    const lead = await setup.transcript(tab.id);
    // The background sub-agent's pending approval waits in the lead's view too.
    assert.deepEqual(
      lead.map((entry) => [entry.kind, entry.agentKey]),
      [
        ["user", undefined],
        ["approval", "tests"],
        ["assistant", undefined],
        ["turn", undefined],
      ],
    );
    const turnId = lead[0].turnId;
    assert.deepEqual(
      idle.plan?.steps.map((step) => step.status),
      ["done", "active"],
    );
    assert.equal(idle.plan?.turnId, turnId);
    const cards = await setup.agents(tab.id);
    assert.deepEqual(
      cards.map((entry) => [entry.agent?.key, entry.agent?.status]),
      [
        ["inspect", "completed"],
        ["readme", "completed"],
        ["tests", "running"],
      ],
    );
    assert.ok(cards.every((entry) => entry.turnId === turnId));
    assert.ok(cards.every((entry) => entry.share === "full"));
    const [inspect, readme, tests] = cards;
    assert.equal(inspect.summary, "Inspect the checkout");
    assert.equal(inspect.detail, "Found README.md.");
    assert.equal(inspect.agent?.type, "Explore");
    assert.equal(inspect.agent?.toolUses, 1);
    assert.equal(inspect.agent?.latestTool, "ls");
    assert.ok(inspect.agent?.endedAt);
    // A nested sub-agent names its parent; its entries carry its own key.
    assert.equal(readme.agent?.parentKey, "inspect");
    assert.deepEqual(
      (await setup.agentTranscript(tab.id, "readme")).map(
        (entry) => entry.summary,
      ),
      ["The README is short."],
    );
    assert.deepEqual(
      (await setup.agentTranscript(tab.id, "inspect")).map(
        (entry) => entry.kind,
      ),
      ["tool", "assistant"],
    );
    assert.equal(tests.agent?.background, true);
    // The approval raised mid-turn is still pending after the turn and names its sub-agent.
    const first = await setup.pending(tab.id, "approval", "tests");
    assert.equal(first.agentKey, "tests");
    assert.equal(first.turnId, turnId);
    await setup.send(tab.id, "Hello");
    await setup.settled(tab.id);
    assert.equal(setup.tab(tab.id).status, "idle");
    await setup.respond(tab.id, first.id);
    assert.ok(fake.calls.includes("respond:tests-1:accept"));
    assert.equal(setup.tab(tab.id).agentRequests, undefined);
    assert.equal(setup.tab(tab.id).runningAgents, 1);
    // Another request after the turn, and entries still file under the spawning turn.
    const second = await setup.pending(tab.id, "approval", "tests");
    assert.equal(setup.tab(tab.id).agentRequests, 1);
    assert.equal(setup.tab(tab.id).status, "idle");
    const tool = (await setup.agentTranscript(tab.id, "tests")).find(
      (entry) => entry.kind === "tool",
    );
    assert.equal(tool?.turnId, turnId);
    await setup.respond(tab.id, second.id);
    await setup.until(
      async () =>
        (await setup.card(tab.id, "tests"))?.agent?.status === "completed",
      "background completion",
    );
    assert.equal(
      (await setup.card(tab.id, "tests"))?.detail,
      "All tests passed.",
    );
    // The harness then wakes the lead with a turn of its own.
    await setup.until(
      async () =>
        (await setup.transcript(tab.id)).at(-1)?.outcome === "completed" &&
        (await setup.transcript(tab.id)).some(
          (entry) => entry.summary === "The background tests passed.",
        ),
      "harness-started turn",
    );
    const woken = (await setup.transcript(tab.id)).find(
      (entry) => entry.summary === "The background tests passed.",
    )!;
    assert.ok(woken.turnId && woken.turnId !== turnId);
    assert.equal(setup.tab(tab.id).status, "idle");
    assert.equal(setup.tab(tab.id).runningAgents, undefined);
  }));

test("Stop on an idle tab stops its background sub-agents", () =>
  withHost(async (setup, fake) => {
    const tab = await setup.open();
    await assert.rejects(setup.stopTab(tab.id), /no running turn/);
    await setup.send(tab.id, "FAKE_AGENTS go");
    await setup.settled(tab.id);
    const approval = await setup.pending(tab.id, "approval", "tests");
    await setup.stopTab(tab.id);
    assert.ok(fake.calls.includes("stop"));
    const tests = await setup.card(tab.id, "tests");
    assert.equal(tests?.agent?.status, "stopped");
    assert.equal(tests?.detail, "Stopped before finishing");
    assert.equal(setup.tab(tab.id).runningAgents, undefined);
    assert.equal(setup.tab(tab.id).agentRequests, undefined);
    assert.equal(
      (await setup.agentTranscript(tab.id, "tests")).find(
        (entry) => entry.id === approval.id,
      )?.state,
      "cancelled",
    );
    await assert.rejects(setup.stopTab(tab.id), /no running turn/);
  }));

test("a sub-agent request never blocks the lead, and Stop cancels both kinds", () =>
  withHost(async (setup, fake) => {
    const tab = await setup.open();
    await setup.send(tab.id, "FAKE_APPROVAL please");
    const lead = await setup.pending(tab.id, "approval");
    assert.equal(setup.tab(tab.id).status, "awaiting_host");
    const session = fake.sessions[0];
    session.emit({ type: "agent", key: "helper", description: "Help" });
    session.emit({
      type: "approval",
      agent: "helper",
      request: "helper-1",
      summary: "Run command: ls",
    });
    const sub = await setup.pending(tab.id, "approval", "helper");
    assert.equal(setup.tab(tab.id).status, "awaiting_host");
    assert.equal(setup.tab(tab.id).agentRequests, 1);
    await setup.stopTab(tab.id);
    await setup.settled(tab.id);
    assert.equal(
      (await setup.transcript(tab.id)).find((entry) => entry.id === lead.id)
        ?.state,
      "cancelled",
    );
    assert.equal(
      (await setup.agentTranscript(tab.id, "helper")).find(
        (entry) => entry.id === sub.id,
      )?.state,
      "cancelled",
    );
    assert.equal(setup.tab(tab.id).agentRequests, undefined);
  }));

test("a sub-agent request during a running turn leaves it running", () =>
  withHost(async (setup, fake) => {
    const tab = await setup.open();
    await setup.send(tab.id, "FAKE_SLOW");
    await setup.until(() => fake.sessions.length === 1, "session");
    const session = fake.sessions[0];
    session.emit({ type: "agent", key: "helper", description: "Help" });
    session.emit({
      type: "question",
      agent: "helper",
      request: "helper-q",
      questions: [
        {
          id: "which",
          header: "Which",
          question: "Which file?",
          options: [],
          multiSelect: false,
          allowOther: true,
          secret: false,
        },
      ],
    });
    const question = await setup.pending(tab.id, "question", "helper");
    assert.equal(setup.tab(tab.id).status, "running");
    session.respond("slow", "accept");
    await setup.settled(tab.id);
    // Still answerable after the turn ended.
    await setup.answer(tab.id, question.id, { which: ["README.md"] });
    assert.ok(fake.calls.includes("answer:helper-q"));
    assert.equal(setup.tab(tab.id).agentRequests, undefined);
  }));

test("a harness-started turn runs like an owner turn and blocks sends until it ends", () =>
  withHost(async (setup, fake) => {
    const tab = await setup.open();
    await setup.send(tab.id, "Hello");
    await setup.settled(tab.id);
    const session = fake.sessions[0];
    session.emit({ type: "turn.started" });
    assert.equal(setup.tab(tab.id).status, "running");
    await assert.rejects(setup.send(tab.id, "Again"), /already running/);
    session.emit({
      type: "message",
      item: "wake",
      kind: "assistant",
      text: "Woken up.",
    });
    session.emit({ type: "turn.completed" });
    assert.equal(setup.tab(tab.id).status, "idle");
    const entries = await setup.transcript(tab.id);
    const woken = entries.find((entry) => entry.summary === "Woken up.")!;
    assert.notEqual(woken.turnId, entries[0].turnId);
    assert.equal(entries.at(-1)?.turnId, woken.turnId);
    assert.equal(entries.at(-1)?.outcome, "completed");
    await setup.send(tab.id, "Again");
    await setup.settled(tab.id);
  }));

test("sub-agent tools update in place after the turn, and re-engaged cards file under the new turn", () =>
  withHost(async (setup, fake) => {
    const tab = await setup.open();
    await setup.send(tab.id, "FAKE_SLOW");
    await setup.until(() => fake.sessions.length === 1, "session");
    const session = fake.sessions[0];
    session.emit({ type: "agent", key: "worker", description: "Build" });
    session.emit({
      type: "tool",
      agent: "worker",
      item: "build",
      summary: "pnpm build",
    });
    session.respond("slow", "accept");
    await setup.settled(tab.id);
    const first = (await setup.transcript(tab.id))[0].turnId;
    session.emit({
      type: "tool",
      agent: "worker",
      item: "build",
      summary: "pnpm build",
      detail: "built",
    });
    session.emit({ type: "agent", key: "worker", status: "completed" });
    let tools = await setup.agentTranscript(tab.id, "worker");
    assert.equal(tools.length, 1);
    assert.equal(tools[0].detail, "built");
    assert.equal(tools[0].turnId, first);
    assert.equal(setup.tab(tab.id).runningAgents, undefined);
    // A follow-up to the finished sub-agent.
    await setup.send(tab.id, "FAKE_SLOW again");
    await setup.until(() => setup.tab(tab.id).status === "running", "turn");
    session.emit({ type: "agent", key: "worker", status: "running" });
    assert.equal(setup.tab(tab.id).runningAgents, 1);
    session.emit({
      type: "message",
      item: "again",
      kind: "assistant",
      agent: "worker",
      text: "Rebuilt.",
    });
    const second = (await setup.transcript(tab.id)).at(-1)!.turnId;
    tools = await setup.agentTranscript(tab.id, "worker");
    assert.equal(tools.at(-1)?.turnId, second);
    assert.notEqual(second, first);
    const worker = await setup.card(tab.id, "worker");
    assert.equal(worker?.turnId, first);
    assert.equal(worker?.agent?.status, "running");
    assert.equal(worker?.agent?.endedAt, undefined);
  }));

test("after a restart running cards read interrupted and idle tabs get no turn notice", async () => {
  const fake = new FakeHarness();
  const first = await start(fake);
  const tab = await first.open();
  await first.send(tab.id, "FAKE_AGENTS go");
  await first.settled(tab.id);
  await first.pending(tab.id, "approval", "tests");
  first.close();

  const second = await start(fake, first);
  try {
    const restored = second.tab(tab.id);
    assert.equal(restored.status, "idle");
    assert.equal(restored.runningAgents, undefined);
    assert.equal(restored.agentRequests, undefined);
    const cards = await second.agents(tab.id);
    const tests = cards.find((entry) => entry.agent?.key === "tests");
    assert.equal(tests?.agent?.status, "interrupted");
    assert.equal(tests?.detail, "Interrupted before finishing");
    assert.equal(
      cards.find((entry) => entry.agent?.key === "inspect")?.agent?.status,
      "completed",
    );
    assert.ok(
      (await second.agentTranscript(tab.id, "tests")).every(
        (entry) => entry.state !== "pending",
      ),
    );
    assert.ok(
      (await second.transcript(tab.id)).every(
        (entry) => entry.notice !== "interrupted",
      ),
    );
  } finally {
    second.close();
  }
});

test("a crash with no turn interrupts running cards, and the stop timeout stops them", () =>
  withHost(async (setup, fake) => {
    const tab = await setup.open();
    await setup.send(tab.id, "FAKE_AGENTS go");
    await setup.settled(tab.id);
    fake.sessions[0].emit({
      type: "crashed",
      message: "The fake harness exited.",
    });
    assert.equal(
      (await setup.card(tab.id, "tests"))?.agent?.status,
      "interrupted",
    );
    assert.equal(setup.tab(tab.id).runningAgents, undefined);
    assert.match(
      (await setup.transcript(tab.id)).at(-1)!.summary,
      /sub-agents were interrupted/,
    );
    // The next turn opens a new session; its harness ignores Stop for this card.
    await setup.send(tab.id, "Hello");
    await setup.settled(tab.id);
    assert.equal(fake.sessions.length, 2);
    fake.sessions[1].emit({
      type: "agent",
      key: "stuck",
      description: "Stuck",
    });
    await setup.stopTab(tab.id);
    assert.equal((await setup.card(tab.id, "stuck"))?.agent?.status, "running");
    await setup.until(
      async () =>
        (await setup.card(tab.id, "stuck"))?.agent?.status === "stopped",
      "stop timeout",
    );
    assert.equal(
      (await setup.card(tab.id, "stuck"))?.detail,
      "Stopped before finishing",
    );
    assert.equal(fake.calls.filter((call) => call === "close").length, 2);
  }));

test("running sub-agents guard close, reset, and harness changes", () =>
  withHost(async (setup, fake) => {
    const tab = await setup.open();
    await setup.send(tab.id, "FAKE_AGENTS go");
    await setup.settled(tab.id);
    await assert.rejects(setup.closeTab(tab.id), /running sub-agents/);
    await assert.rejects(
      setup.resetSession(tab.id),
      /sub-agents are still running/,
    );
    await assert.rejects(
      setup.setLoadout(tab.id, {
        ...setup.tab(tab.id).loadout,
        harness: "claude",
      }),
      /sub-agents are still running/,
    );
    // Other loadout changes stay open.
    await setup.setLoadout(tab.id, {
      ...setup.tab(tab.id).loadout,
      effort: "low",
    });
    await setup.closeTab(tab.id, true);
    assert.equal(setup.tabs().length, 0);
    assert.ok(fake.calls.includes("stop"));
  }));

test("the lead plan lands on the tab, sub-agent plans stay off it, and a reset clears it", () =>
  withHost(async (setup, fake) => {
    const tab = await setup.open();
    await setup.setLoadout(tab.id, { ...tab.loadout, planMode: true });
    await setup.send(tab.id, "FAKE_SLOW");
    await setup.until(() => fake.sessions.length === 1, "session");
    const session = fake.sessions[0];
    session.emit({ type: "agent", key: "planner", description: "Plan" });
    session.emit({
      type: "message",
      item: "plan",
      kind: "plan",
      agent: "planner",
      text: "1. Sub-agent step",
    });
    session.emit({
      type: "steps",
      steps: [{ text: "Lead step", status: "pending" }],
    });
    session.respond("slow", "accept");
    await setup.settled(tab.id);
    const plan = (await setup.agentTranscript(tab.id, "planner"))[0];
    assert.equal(plan.kind, "plan");
    assert.equal(plan.continuable, undefined);
    assert.deepEqual(setup.tab(tab.id).plan?.steps, [
      { text: "Lead step", status: "pending" },
    ]);
    session.emit({ type: "agent", key: "planner", status: "completed" });
    await setup.resetSession(tab.id);
    assert.equal(setup.tab(tab.id).plan, undefined);
  }));

test("read-along windows open at the next seq, close after a flushed paused notice, and persist", async () => {
  const fake = new FakeHarness("codex");
  const setup = await start(fake);
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
  const roomId = shared.id;
  let tabId = "";
  const room = () =>
    setup.service.snapshot().rooms.find((item) => item.id === roomId)!;
  const tab = () => room().tabs.find((item) => item.id === tabId)!;
  const toggle = (on: boolean) =>
    setup.dispatch({ type: "tab.setReadAlong", roomId, tabId, on });
  const lead = async () =>
    (await setup.dispatch({ type: "tab.transcript", roomId, tabId }))
      .transcript!.entries;
  try {
    // Local rooms cannot share.
    const local = await setup.open();
    await assert.rejects(
      setup.dispatch({
        type: "tab.setReadAlong",
        roomId: setup.roomId,
        tabId: local.id,
        on: true,
      }),
      /needs a shared room/,
    );
    await setup.dispatch({ type: "shared.import", room: shared });
    await setup.dispatch({
      type: "workspace.register",
      roomId,
      workspace: await inspectWorkspace(setup.repo),
    });
    await setup.dispatch({ type: "tab.open", roomId, harness: "codex" });
    tabId = room().tabs[0].id;
    assert.equal(tab().readAlong, false);
    assert.deepEqual(tab().readAlongWindows, []);
    await setup.send(tabId, "Before sharing", { roomId });
    await setup.settled(tabId, roomId);
    const before = await lead();

    // Covers AE1: the window starts at the next entry's seq.
    await toggle(true);
    assert.equal(tab().readAlong, true);
    assert.deepEqual(tab().readAlongWindows, [
      { onSeq: before.at(-1)!.seq + 1, offSeq: null },
    ]);
    await setup.send(tabId, "While sharing", { roomId });
    await setup.settled(tabId, roomId);
    const shared1 = (await lead()).filter(
      (entry) => entry.seq >= tab().readAlongWindows[0].onSeq,
    );
    assert.equal(shared1[0].kind, "user");
    assert.ok(
      before.every((entry) => entry.seq < tab().readAlongWindows[0].onSeq),
    );

    // Covers AE11: off appends the paused notice inside the window, emitted before the closing snapshot.
    const mark = setup.emitted.length;
    await toggle(false);
    const paused = (await lead()).at(-1)!;
    assert.equal(paused.summary, "Read-along paused.");
    assert.deepEqual(tab().readAlongWindows[0].offSeq, paused.seq + 1);
    const after = setup.emitted.slice(mark);
    const batchAt = after.findIndex(
      (item) =>
        item.kind === "batch" &&
        item.batch.entries.some((entry) => entry.id === paused.id),
    );
    const closedAt = after.findIndex(
      (item) =>
        item.kind === "snapshot" &&
        item.snapshot.rooms.find((r) => r.id === roomId)?.tabs[0]
          .readAlongWindows[0].offSeq != null,
    );
    assert.ok(batchAt >= 0 && batchAt < closedAt);

    await setup.send(tabId, "Private turn", { roomId });
    await setup.settled(tabId, roomId);
    const privateSeqs = (await lead())
      .filter((entry) => entry.seq > paused.seq)
      .map((entry) => entry.seq);
    await toggle(true);
    await setup.until(
      async () => (await lead()).at(-1)!.summary === "Read-along resumed.",
      "resumed notice",
    );
    const resumed = (await lead()).at(-1)!;
    const windows = tab().readAlongWindows;
    assert.equal(windows.length, 2);
    assert.equal(windows[1].onSeq, resumed.seq);
    for (const seq of privateSeqs)
      assert.ok(
        !windows.some(
          (w) => w.onSeq <= seq && (w.offSeq === null || seq < w.offSeq),
        ),
      );

    // An ascending page after a seq, as the publisher's backfill reads it.
    const since = await setup.dispatch({
      type: "tab.transcript",
      roomId,
      tabId,
      afterSeq: paused.seq,
      limit: 2,
    });
    assert.deepEqual(
      since.transcript!.entries.map((entry) => entry.seq),
      privateSeqs.slice(0, 2),
    );
    assert.equal(since.transcript!.nextSeq, privateSeqs[1]);
  } finally {
    setup.close();
  }
  // Covers R16: the switch and its windows survive a restart.
  const restarted = await start(new FakeHarness("codex"), setup);
  try {
    const restored = restarted.service
      .snapshot()
      .rooms.find((item) => item.id === roomId)!.tabs[0];
    assert.equal(restored.readAlong, true);
    assert.equal(restored.readAlongWindows.length, 2);
  } finally {
    restarted.close();
  }
});

test("a discarding switch-off closes the window where it began, with no paused notice", () =>
  withHost(async (setup) => {
    const room = {
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
    await setup.dispatch({ type: "shared.import", room });
    await setup.dispatch({
      type: "tab.open",
      roomId: room.id,
      harness: "codex",
    });
    const tabId = setup.tabs(room.id)[0].id;
    const toggle = (on: boolean, discard?: true) =>
      setup.dispatch({
        type: "tab.setReadAlong",
        roomId: room.id,
        tabId,
        on,
        ...(discard ? { discard } : {}),
      });
    await toggle(true);
    await toggle(false, true);
    const tab = setup.tab(tabId, room.id);
    assert.equal(tab.readAlong, false);
    assert.deepEqual(tab.readAlongWindows, [{ onSeq: 1, offSeq: 1 }]);
    const entries = (
      await setup.dispatch({ type: "tab.transcript", roomId: room.id, tabId })
    ).transcript!.entries;
    assert.deepEqual(entries, []);
  }));

test("only a closed chat can be deleted, and deleting removes its transcript", () =>
  withHost(async (setup) => {
    const tab = await setup.open();
    await setup.send(tab.id, "Hello there");
    await setup.settled(tab.id);
    const remove = () =>
      setup.dispatch({
        type: "tab.delete",
        roomId: setup.roomId,
        tabId: tab.id,
      });
    await assert.rejects(remove(), /Only a closed chat/);
    await setup.closeTab(tab.id);
    assert.ok(setup.journal.lastSeq(tab.id) > 0);
    await remove();
    assert.deepEqual(setup.service.snapshot().rooms[0].closedTabs, []);
    assert.equal(setup.journal.lastSeq(tab.id), 0);
  }));
