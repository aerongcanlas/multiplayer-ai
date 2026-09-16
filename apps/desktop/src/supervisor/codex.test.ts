import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { CodexClient } from "./codex-client";
import { CodexRunner } from "./codex-runner";
import { SupervisorService } from "./service";
import { Journal } from "./journal";
import { inspectWorkspace } from "./workspace";
import { Worktrees, repositoryCommand } from "./worktrees";
import type { Execution } from "../shared/contracts";
const fixture = resolve("scripts/codex-fixture.mjs");
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "multiplayer-codex-"));
  const repo = join(dir, "repo");
  await mkdir(repo);
  execFileSync("git", ["-C", repo, "init"], {
    windowsHide: true,
    stdio: "pipe",
  });
  await writeFile(join(repo, "README.md"), "Original\n");
  await repositoryCommand(repo, "add", "README.md");
  await repositoryCommand(
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Fixture",
  );
  const client = new CodexClient({
    executable: process.execPath,
    args: [fixture],
    cwd: dir,
    env: { ...process.env, MP_FIXTURE_SIGNED_IN: "1" },
  });
  const service = new SupervisorService(
    new Journal(join(dir, "state.sqlite")),
    () => {},
    undefined,
    new CodexRunner(client, join(dir, "worktrees")),
  );
  const roomId = service.snapshot().rooms[0].id;
  await service.dispatch({
    type: "workspace.register",
    roomId,
    workspace: await inspectWorkspace(repo),
  });
  return { dir, repo, client, service, roomId };
}
async function until(
  service: SupervisorService,
  predicate: (run: Execution) => boolean,
) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const run = service.snapshot().rooms[0].executions.at(-1);
    if (run && predicate(run)) return run;
    await wait(25);
  }
  throw new Error("Codex fixture did not reach the expected state.");
}
async function start(
  service: SupervisorService,
  roomId: string,
  prompt: string,
) {
  return service.dispatch({
    type: "execution.start",
    roomId,
    prompt,
    runner: "codex",
    configuration: {
      model: "fixture-codex",
      effort: "medium",
      mode: "read-only",
      concurrency: 2,
    },
    scenario: "success",
  });
}
test("Codex lead schedules specialists, persists real event types, and retains summary after restart", async () => {
  const { service, roomId, dir, repo } = await setup();
  try {
    await start(service, roomId, "Inspect this repository");
    const run = await until(service, (run) => run.status !== "running");
    assert.equal(run.status, "completed");
    assert.deepEqual(
      run.tasks.map((task) => task.role),
      ["lead", "planner", "validator"],
    );
    assert.ok(run.evidence.some((item) => item.kind === "command"));
    assert.ok(run.evidence.some((item) => item.kind === "review"));
    assert.equal(await readFile(join(repo, "README.md"), "utf8"), "Original\n");
    assert.equal(service.snapshot().provider?.account?.plan, "pro");
    assert.ok(!JSON.stringify(run).includes("fixture@example.invalid"));
  } finally {
    service.close();
  }
  const reopened = new SupervisorService(
    new Journal(join(dir, "state.sqlite")),
    () => {},
  );
  assert.equal(reopened.snapshot().rooms[0].summaries.length, 1);
  reopened.close();
});
test("approval decisions are execution-scoped and declining retains a failed result", async () => {
  const { service, roomId } = await setup();
  try {
    await start(service, roomId, "FIXTURE_APPROVAL");
    const run = await until(service, (run) => Boolean(run.approvals?.length));
    assert.equal(run.tasks[0].status, "waiting_for_input");
    await assert.rejects(
      service.dispatch({
        type: "approval.respond",
        roomId,
        executionId: run.id,
        approvalId: "00000000-0000-4000-8000-000000000000",
        decision: "accept",
      }),
      /no longer pending/,
    );
    await service.dispatch({
      type: "approval.respond",
      roomId,
      executionId: run.id,
      approvalId: run.approvals![0].id,
      decision: "decline",
    });
    assert.equal(
      (await until(service, (run) => run.status !== "running")).status,
      "failed",
    );
  } finally {
    service.close();
  }
});
test("Stop interrupts a provider turn and prevents late completion from changing cancelled state", async () => {
  const { service, roomId } = await setup();
  try {
    await start(service, roomId, "FIXTURE_CANCEL");
    const run = await until(
      service,
      (run) => run.tasks[0].status === "running",
    );
    await service.dispatch({
      type: "execution.stop",
      roomId,
      executionId: run.id,
    });
    await wait(300);
    assert.equal(service.snapshot().rooms[0].executions[0].status, "cancelled");
  } finally {
    service.close();
  }
});
test("failed specialist review cannot become a successful execution", async () => {
  const { service, roomId } = await setup();
  try {
    await start(service, roomId, "FIXTURE_FAILED_REVIEW");
    assert.equal(
      (await until(service, (run) => run.status !== "running")).status,
      "failed",
    );
  } finally {
    service.close();
  }
});
test("worktrees integrate isolated changes while preserving the original checkout", async () => {
  const { service, repo, dir } = await setup();
  try {
    const baseline = await repositoryCommand(repo, "rev-parse", "HEAD");
    const worktrees = new Worktrees(
      repo,
      join(dir, "trees"),
      "test-run",
      baseline,
    );
    await worktrees.prepare();
    const assigned = await worktrees.assign("worker");
    await writeFile(join(assigned, "README.md"), "Updated\n");
    await worktrees.integrate(assigned);
    const artifact = await worktrees.artifact();
    assert.deepEqual(artifact.files, ["README.md"]);
    assert.match(artifact.diff, /Updated/);
    assert.equal(await readFile(join(repo, "README.md"), "utf8"), "Original\n");
    assert.equal(await repositoryCommand(repo, "rev-parse", "HEAD"), baseline);
    const committed = await worktrees.assign("unexpected-commit");
    await writeFile(join(committed, "README.md"), "Agent committed directly\n");
    await repositoryCommand(committed, "add", "README.md");
    await repositoryCommand(committed, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Unexpected history change");
    await assert.rejects(worktrees.integrate(committed), /changed Git history/);
    assert.equal((await worktrees.artifact()).revision, artifact.revision);
  } finally {
    service.close();
  }
});
