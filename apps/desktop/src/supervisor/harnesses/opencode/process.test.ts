import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import type {
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  OpenCodeProcess,
  runCommand,
  type Launcher,
  type ProcessOwner,
} from "./process";

const FIXTURE = fileURLToPath(
  new URL("../../../../scripts/opencode-fixture.mjs", import.meta.url),
);
const fixture: Launcher = (_executable, args, env) => ({
  executable: process.execPath,
  args: [FIXTURE, ...args],
  env,
});

async function setup(idleMs = 60_000) {
  const dir = await mkdtemp(join(tmpdir(), "multiplayer-opencode-"));
  const log = join(dir, "fixture.log");
  const updates: SessionNotification[] = [];
  const exits: string[] = [];
  const owner: ProcessOwner & { closed: boolean } = {
    idleMs,
    closed: false,
    update: (_process, params) => void updates.push(params),
    permission: async (): Promise<RequestPermissionResponse> => ({
      outcome: { outcome: "cancelled" },
    }),
    exited: (_process, message) => void exits.push(message),
    forget: () => {},
  };
  const context = {
    executable: "/opt/opencode",
    env: {
      PATH: process.env.PATH ?? "",
      MP_FIXTURE_LOG: log,
      OPENAI_API_KEY: "sk-host",
      ANTHROPIC_API_KEY: "sk-ant",
      XDG_DATA_HOME: join(dir, "data"),
    },
    home: "",
    hostPaths: {},
  };
  const spawn = (key = "a") =>
    new OpenCodeProcess(
      key,
      context,
      { OPENCODE_CONFIG_CONTENT: '{"model":"fixture/one"}' },
      fixture,
      owner,
    );
  const entries = async () =>
    (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { dir, log, updates, exits, owner, context, spawn, entries };
}

test("a process starts locked down and runs a full turn over ACP", async () => {
  const { spawn, entries, updates } = await setup();
  const process = spawn();
  try {
    await process.ready;
    assert.equal(process.version, "1.18.34");
    const session = await process.call((connection) =>
      connection.newSession({ cwd: tmpdir(), mcpServers: [] }),
    );
    const result = await process.call((connection) =>
      connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "Say hello" }],
      }),
    );
    assert.equal(result.stopReason, "end_turn");
    const chunks = updates
      .map((item) => item.update)
      .filter((item) => item.sessionUpdate === "agent_message_chunk")
      .map((item) => (item.content.type === "text" ? item.content.text : ""));
    assert.deepEqual(chunks, ["Hello ", "world."]);
    const start = (await entries()).find((entry) => entry.start)!;
    assert.deepEqual(start.argv, [
      "acp",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ]);
    // A random password of at least 32 bytes, no auto-update, and no provider keys.
    assert.ok(Number(start.passwordLength) >= 43);
    assert.equal(start.autoupdate, "1");
    assert.deepEqual(start.providerKeys, []);
    assert.equal(start.content, '{"model":"fixture/one"}');
    const initialize = (await entries()).find(
      (entry) => entry.method === "initialize",
    )!;
    const capabilities = (
      initialize.params as { clientCapabilities: Record<string, unknown> }
    ).clientCapabilities;
    assert.deepEqual(capabilities.fs, {
      readTextFile: false,
      writeTextFile: false,
    });
    assert.equal(capabilities.terminal, false);
  } finally {
    process.close();
  }
});

test("two processes never share a server password", async () => {
  const { spawn, entries } = await setup();
  const first = spawn("a");
  const second = spawn("b");
  try {
    await Promise.all([first.ready, second.ready]);
    const passwords = (await entries())
      .filter((entry) => entry.start)
      .map((entry) => entry.password);
    assert.equal(passwords.length, 2);
    assert.notEqual(passwords[0], passwords[1]);
  } finally {
    first.close();
    second.close();
  }
});

test("an idle process closes, and a closed one never re-arms its timer", async () => {
  const { spawn, exits } = await setup(50);
  const process = spawn();
  await process.ready;
  process.hold();
  process.release();
  await wait(300);
  assert.equal(process.alive, false);
  // A deliberate close is not a crash.
  assert.deepEqual(exits, []);
  process.touch();
  process.release();
  assert.equal(process.alive, false);
});

test("an exit mid-turn rejects the pending request and reports the crash", async () => {
  const { spawn, exits } = await setup();
  const process = spawn();
  await process.ready;
  const session = await process.call((connection) =>
    connection.newSession({ cwd: tmpdir(), mcpServers: [] }),
  );
  await assert.rejects(
    process.call((connection) =>
      connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "FIXTURE_CRASH" }],
      }),
    ),
  );
  while (!exits.length) await wait(10);
  assert.equal(process.alive, false);
  assert.deepEqual(exits, ["OpenCode exited with code 3."]);
  await assert.rejects(
    process.call((connection) =>
      connection.newSession({ cwd: tmpdir(), mcpServers: [] }),
    ),
    /no longer running/,
  );
});

test("a retired process keeps its running turn and closes when the turn ends", async () => {
  const { spawn } = await setup();
  const old = spawn("old");
  await old.ready;
  // Tab A's turn holds the old process while it waits on an approval.
  old.hold();
  old.retire();
  assert.equal(old.alive, true);
  assert.equal(old.draining, true);
  // Tab B starts at once on the process for the new config.
  const next = spawn("new");
  await next.ready;
  assert.equal(next.alive, true);
  old.release();
  assert.equal(old.alive, false);
  assert.equal(next.alive, true);
  next.close();
});

test("one-shot commands run in the given folder with the locked environment", async () => {
  const { context, dir } = await setup();
  await writeFile(
    join(dir, "opencode.json"),
    JSON.stringify({ provider: { ollama: {} } }),
  );
  const output = await runCommand(context, fixture, ["debug", "config"], {
    cwd: dir,
    config: { OPENCODE_CONFIG_CONTENT: "{}" },
  });
  assert.deepEqual(JSON.parse(output), { provider: { ollama: {} } });
  await assert.rejects(
    runCommand(context, fixture, ["unknown"], { cwd: dir, config: {} }),
    /could not run `unknown`/,
  );
});
