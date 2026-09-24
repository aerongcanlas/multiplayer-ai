import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { Journal } from "./journal";
import { SupervisorService } from "./service";
import { inspectWorkspace } from "./workspace";
import { HarnessRegistry } from "./harnesses/registry";
import { FakeHarness } from "./harnesses/fake";
import { ProgramManager } from "./programs/manager";
import { HARNESS_MANIFEST } from "./programs/manifest";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "multiplayer-desktop-test-"));
  const repo = join(dir, "repo");
  await mkdir(repo);
  execFileSync("git", ["-C", repo, "init"], { stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=Desktop Test",
      "-c",
      "user.email=desktop@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "-m",
      "Test fixture",
    ],
    { stdio: "pipe" },
  );
  const executable = join(dir, "fake-codex");
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);
  const journal = new Journal(join(dir, "state.sqlite"));
  journal.setSetting("harness.codex.executable", executable);
  const fake = new FakeHarness();
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
    publishTranscript: () => {},
    transcriptInterval: 5,
  });
  changed = () => service.harnessesChanged();
  await registry.refresh("codex");
  const roomId = service.snapshot().rooms[0].id;
  await service.dispatch({
    type: "workspace.register",
    roomId,
    workspace: await inspectWorkspace(repo),
  });
  const settled = async (roomId: string, tabId: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const tab = service
        .snapshot()
        .rooms.find((room) => room.id === roomId)
        ?.tabs.find((tab) => tab.id === tabId);
      if (tab && !["running", "awaiting_host"].includes(tab.status)) return;
      await wait(10);
    }
    throw new Error("The turn did not finish.");
  };
  return { dir, journal, service, roomId, fake, settled };
}

test("a suggestion used in a tab is submitted in a local room and stays draft in a shared room", async () => {
  const { service, roomId, journal, settled, fake } = await setup();
  try {
    await service.dispatch({
      type: "message.send",
      roomId,
      text: "Shared feedback",
    });
    const original = service.snapshot().rooms[0];
    await service.dispatch({
      type: "suggestion.create",
      roomId,
      messageIds: [original.messages[0].id],
    });
    // The shared copy carries the suggestion as the room's canonical draft.
    const drafted = structuredClone(service.snapshot().rooms[0]);
    await service.dispatch({ type: "tab.open", roomId, harness: "codex" });
    const local = service.snapshot().rooms[0];
    await service.dispatch({
      type: "tab.send",
      roomId,
      tabId: local.tabs[0].id,
      text: local.suggestions[0].prompt,
      suggestionId: local.suggestions[0].id,
      suggestionRevision: 1,
    });
    await settled(roomId, local.tabs[0].id);
    assert.equal(
      service.snapshot().rooms[0].suggestions[0].status,
      "submitted",
    );

    // A shared room imports canonical chat and suggestions; its tabs stay on this desktop.
    const shared = {
      ...drafted,
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
    await service.dispatch({ type: "shared.import", room: shared });
    await service.dispatch({
      type: "workspace.register",
      roomId: shared.id,
      workspace: journal.getWorkspace(local.workspace!.id)!,
    });
    await service.dispatch({
      type: "tab.open",
      roomId: shared.id,
      harness: "codex",
    });
    const room = () => service.snapshot().rooms[1];
    const tabId = room().tabs[0].id;
    await service.dispatch({
      type: "tab.send",
      roomId: shared.id,
      tabId,
      text: "Use room feedback",
      suggestionId: shared.suggestions[0].id,
      suggestionRevision: 1,
    });
    await settled(shared.id, tabId);
    assert.equal(room().suggestions[0].status, "draft");
    await service.dispatch({ type: "shared.import", room: shared });
    assert.equal(room().tabs[0].id, tabId);
    assert.ok(room().workspace);
    assert.equal(
      fake.calls.filter((call) => call.startsWith("send:")).length,
      2,
    );
  } finally {
    service.close();
  }
});

test("messages and editable attributed suggestions persist; generating a suggestion does not dispatch work", async () => {
  const { service, roomId, dir, fake } = await setup();
  try {
    await service.dispatch({
      type: "message.send",
      roomId,
      text: "Keep the existing component architecture.",
    });
    const message = service.snapshot().rooms[0].messages[0];
    await service.dispatch({
      type: "suggestion.create",
      roomId,
      messageIds: [message.id],
    });
    const suggestion = service.snapshot().rooms[0].suggestions[0];
    assert.deepEqual(service.snapshot().rooms[0].tabs, []);
    assert.equal(
      fake.calls.some((call) => call.startsWith("send:")),
      false,
    );
    assert.equal(suggestion.sources[0].text, message.text);
    assert.equal(suggestion.contextVersion, 0);
    await service.dispatch({
      type: "suggestion.edit",
      roomId,
      suggestionId: suggestion.id,
      prompt: "Review first.",
      expectedRevision: 1,
    });
    await assert.rejects(
      service.dispatch({
        type: "suggestion.edit",
        roomId,
        suggestionId: suggestion.id,
        prompt: "Overwrite.",
        expectedRevision: 1,
      }),
      /changed/,
    );
    const persisted = new Journal(join(dir, "state.sqlite"));
    assert.equal(
      persisted.load().rooms[0].suggestions[0].prompt,
      "Review first.",
    );
    assert.equal(
      persisted.load().rooms[0].suggestions[0].sources[0].id,
      message.id,
    );
    persisted.close();
  } finally {
    service.close();
  }
});

test("cross-room and unknown messages are rejected without mutating state", async () => {
  const { service, roomId } = await setup();
  try {
    await service.dispatch({ type: "room.create", name: "Another room" });
    const other = service.snapshot().rooms[1];
    await service.dispatch({
      type: "message.send",
      roomId: other.id,
      text: "Private to this room.",
    });
    const revision = service.snapshot().revision;
    await assert.rejects(
      service.dispatch({
        type: "suggestion.create",
        roomId,
        messageIds: [service.snapshot().rooms[1].messages[0].id],
      }),
      /does not belong/,
    );
    await assert.rejects(
      service.dispatch({
        type: "suggestion.create",
        roomId,
        messageIds: [randomUUID()],
      }),
      /does not belong/,
    );
    assert.equal(service.snapshot().revision, revision);
  } finally {
    service.close();
  }
});

test("the repository cannot change under a running tab", async () => {
  const { service, roomId, journal, settled } = await setup();
  try {
    await service.dispatch({ type: "tab.open", roomId, harness: "codex" });
    const room = service.snapshot().rooms[0];
    await service.dispatch({
      type: "tab.send",
      roomId,
      tabId: room.tabs[0].id,
      text: "FAKE_SLOW",
    });
    await assert.rejects(
      service.dispatch({
        type: "workspace.register",
        roomId,
        workspace: journal.getWorkspace(room.workspace!.id)!,
      }),
      /Stop running tabs/,
    );
    await service.dispatch({
      type: "tab.stop",
      roomId,
      tabId: room.tabs[0].id,
    });
    await settled(roomId, room.tabs[0].id);
  } finally {
    service.close();
  }
});
