import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { Journal } from "./journal";
import { MockRunner } from "./runner";
import { SupervisorService } from "./service";
import { inspectWorkspace } from "./workspace";
import { currentExecution, type Execution } from "../shared/contracts";

async function setup(interval = 1) {
  const dir = await mkdtemp(join(tmpdir(), "multiplayer-desktop-test-"));
  const repo = join(dir, "repo");
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      windowsHide: true,
      stdio: "pipe",
    });
  git("init");
  git(
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
  );
  const journal = new Journal(join(dir, "state.sqlite"));
  const service = new SupervisorService(
    journal,
    () => {},
    new MockRunner(interval),
  );
  const roomId = service.snapshot().rooms[0].id;
  await service.dispatch({
    type: "workspace.register",
    roomId,
    workspace: await inspectWorkspace(repo),
  });
  return { dir, repo, journal, service, roomId, git };
}

async function terminal(service: SupervisorService): Promise<Execution> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const run = currentExecution(service.snapshot().rooms[0]);
    if (run && run.status !== "running") return run;
    await wait(20);
  }
  throw new Error("Execution did not finish within 2 seconds.");
}

test("shared feedback is imported canonically while host execution history stays local", async () => {
  const { service, roomId, journal } = await setup();
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
    const shared = {
      ...service.snapshot().rooms[0],
      shared: {
        userId: randomUUID(),
        project: "test",
        isAdmin: true,
        members: [],
      },
    };
    // Simulate a first import into a distinct shared room, followed by a private repository selection.
    shared.id = randomUUID();
    shared.workspace = null;
    await service.dispatch({ type: "shared.import", room: shared });
    const workspace = service.snapshot().rooms[0].workspace!;
    const privateWorkspace = journal.getWorkspace(workspace.id)!;
    await service.dispatch({
      type: "workspace.register",
      roomId: shared.id,
      workspace: privateWorkspace,
    });
    await service.dispatch({
      type: "execution.start",
      roomId: shared.id,
      prompt: "Use room feedback",
      suggestionId: shared.suggestions[0].id,
      suggestionRevision: 1,
      scenario: "success",
    });
    for (
      let i = 0;
      i < 100 && service.snapshot().rooms[1].executions[0].status === "running";
      i++
    )
      await wait(20);
    assert.equal(service.snapshot().rooms[1].executions[0].status, "completed");
    await service.dispatch({ type: "shared.import", room: shared });
    const imported = service.snapshot().rooms[1];
    assert.equal(imported.executions.length, 1);
    assert.ok(imported.workspace);
    assert.equal(imported.suggestions[0].status, "draft");
    assert.equal(
      imported.executions[0].sourceSuggestion?.sources[0].text,
      "Shared feedback",
    );
    await service.dispatch({
      type: "execution.start",
      roomId: shared.id,
      prompt: "Reuse shared feedback with newer local context",
      suggestionId: shared.suggestions[0].id,
      suggestionRevision: 1,
      scenario: "success",
    });
    assert.equal(service.snapshot().rooms[1].executions.length, 2);
  } finally {
    service.close();
  }
});

test("messages and editable attributed suggestions persist; generating a suggestion does not dispatch work", async () => {
  const { service, roomId, dir } = await setup();
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
    assert.equal(service.snapshot().rooms[0].executions.length, 0);
    assert.equal(suggestion.sources[0].text, message.text);
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

test("one mock execution emits ordered task events and simulated evidence without changing Git", async () => {
  const { service, roomId, journal, git } = await setup();
  try {
    const before = git("status", "--porcelain").toString();
    await service.dispatch({
      type: "execution.start",
      roomId,
      prompt: "Demonstrate the local workflow.",
      scenario: "success",
    });
    const run = await terminal(service);
    assert.equal(run.status, "completed");
    assert.ok(run.tasks.every((task) => task.status === "completed"));
    assert.equal(run.evidence[0].kind, "simulation");
    assert.equal(run.evidence[0].outcome, "passed");
    assert.deepEqual(
      run.events.map((event) => event.seq),
      run.events.map((_, index) => index + 1),
    );
    assert.equal(journal.eventCount(), run.events.length);
    assert.equal(service.snapshot().rooms[0].summaries[0].version, 1);
    assert.equal(git("status", "--porcelain").toString(), before);
    assert.equal(JSON.stringify(service.snapshot()).includes('"path"'), false);
    journal.save(service.snapshot(), run.events);
    assert.equal(
      journal.eventCount(),
      run.events.length,
      "duplicate event delivery must not duplicate persisted records",
    );
  } finally {
    service.close();
  }
});

test("failed mock validation remains visible and does not mark the lead complete", async () => {
  const { service, roomId } = await setup();
  try {
    await service.dispatch({
      type: "execution.start",
      roomId,
      prompt: "Exercise a failure.",
      scenario: "validation-failure",
    });
    const run = await terminal(service);
    assert.equal(run.status, "failed");
    assert.equal(run.tasks[0].status, "failed");
    assert.equal(run.evidence[0].outcome, "failed");
  } finally {
    service.close();
  }
});

test("stop prevents subsequent runner updates and active-run concurrency is bounded", async () => {
  const { service, roomId } = await setup(100);
  try {
    await service.dispatch({
      type: "execution.start",
      roomId,
      prompt: "Stop this run.",
      scenario: "success",
    });
    await assert.rejects(
      service.dispatch({
        type: "execution.start",
        roomId,
        prompt: "Concurrent run.",
        scenario: "success",
      }),
      /active execution/,
    );
    const id = currentExecution(service.snapshot().rooms[0])!.id;
    await service.dispatch({ type: "execution.stop", roomId, executionId: id });
    const revision = service.snapshot().revision;
    await wait(150);
    assert.equal(service.snapshot().revision, revision);
    assert.equal(
      currentExecution(service.snapshot().rooms[0])?.status,
      "cancelled",
    );
  } finally {
    service.close();
  }
});

test("restart recovers an interrupted execution as blocked and never replays it", async () => {
  const { service, roomId, dir } = await setup(100);
  await service.dispatch({
    type: "execution.start",
    roomId,
    prompt: "Interrupt this run.",
    scenario: "success",
  });
  service.close();
  const recovered = new SupervisorService(
    new Journal(join(dir, "state.sqlite")),
    () => {},
    new MockRunner(1),
  );
  try {
    assert.equal(
      currentExecution(recovered.snapshot().rooms[0])?.status,
      "blocked",
    );
    const revision = recovered.snapshot().revision;
    await wait(50);
    assert.equal(recovered.snapshot().revision, revision);
    assert.equal(
      currentExecution(recovered.snapshot().rooms[0])?.events.at(-1)?.type,
      "recovery",
    );
  } finally {
    recovered.close();
  }
});

test("stale suggestion context cannot silently steer a new execution", async () => {
  const { service, roomId } = await setup();
  try {
    await service.dispatch({
      type: "message.send",
      roomId,
      text: "A direction from context zero.",
    });
    await service.dispatch({
      type: "suggestion.create",
      roomId,
      messageIds: [service.snapshot().rooms[0].messages[0].id],
    });
    const suggestion = service.snapshot().rooms[0].suggestions[0];
    await service.dispatch({
      type: "execution.start",
      roomId,
      prompt: "Advance the context.",
      scenario: "success",
    });
    await terminal(service);
    await assert.rejects(
      service.dispatch({
        type: "execution.start",
        roomId,
        prompt: suggestion.prompt,
        suggestionId: suggestion.id,
        suggestionRevision: suggestion.revision,
        scenario: "success",
      }),
      /older context/,
    );
  } finally {
    service.close();
  }
});
