import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import {
  CLAUDE_ACCOUNT,
  credentialWarning,
  hostMcpServers,
  migrateSession,
} from "./account";
import { logout, startLogin } from "./auth";
import { Accounts } from "../accounts";

const temp = () => mkdtemp(join(tmpdir(), "multiplayer-claude-account-"));

test("the Claude home links the host's setup and copies settings.json", async () => {
  const dir = await temp();
  const host = join(dir, ".claude");
  for (const name of [
    "skills",
    "agents",
    "commands",
    "output-styles",
    "plugins",
  ])
    await mkdir(join(host, name), { recursive: true });
  await writeFile(join(host, "CLAUDE.md"), "instructions");
  await writeFile(join(host, "settings.json"), "{}");
  await writeFile(join(host, ".credentials.json"), "secret");
  await mkdir(join(host, "projects", "-repo", "memory"), { recursive: true });
  const accounts = new Accounts(join(dir, "accounts"));
  const home = await accounts.prepare("claude", CLAUDE_ACCOUNT, { HOME: dir });
  const names = (await readdir(home)).sort();
  assert.deepEqual(names, [
    ".multiplayer-links.json",
    "CLAUDE.md",
    "agents",
    "commands",
    "output-styles",
    "plugins",
    "projects",
    "settings.json",
    "skills",
  ]);
  assert.ok((await stat(join(home, "settings.json"))).isFile());
});

async function mcpHost() {
  const dir = await temp();
  const config = (user: string, local: string) => ({
    mcpServers: {
      [user]: {
        type: "stdio",
        command: "server",
        env: { API_TOKEN: "fixture-mcp-secret-env" },
      },
    },
    projects: {
      "/repo": {
        mcpServers: {
          [local]: {
            type: "http",
            url: "https://mcp.example.invalid",
            headers: { Authorization: "Bearer fixture-mcp-secret-header" },
          },
        },
      },
    },
  });
  await writeFile(join(dir, ".claude.json"), JSON.stringify(config("a", "b")));
  // A decoy inside the host's .claude folder is never read.
  await mkdir(join(dir, ".claude"));
  await writeFile(
    join(dir, ".claude", ".claude.json"),
    JSON.stringify(config("decoy", "decoy-local")),
  );
  return dir;
}

test("host MCP servers come from $HOME/.claude.json, user plus local for the folder", async () => {
  const dir = await mcpHost();
  assert.deepEqual(
    Object.keys(await hostMcpServers({ HOME: dir }, "/repo")).sort(),
    ["a", "b"],
  );
  assert.deepEqual(Object.keys(await hostMcpServers({ HOME: dir }, "/other")), [
    "a",
  ]);
});

test("with a host CLAUDE_CONFIG_DIR, MCP servers come from that folder's .claude.json", async () => {
  const dir = await mcpHost();
  const custom = join(dir, "custom");
  await mkdir(custom);
  await writeFile(
    join(custom, ".claude.json"),
    JSON.stringify({ mcpServers: { c: { type: "stdio", command: "c" } } }),
  );
  assert.deepEqual(
    Object.keys(
      await hostMcpServers({ HOME: dir, CLAUDE_CONFIG_DIR: custom }, "/repo"),
    ),
    ["c"],
  );
});

test("a missing or invalid .claude.json gives no servers", async () => {
  const dir = await temp();
  assert.deepEqual(await hostMcpServers({ HOME: dir }, "/repo"), {});
  await writeFile(join(dir, ".claude.json"), "{not json");
  assert.deepEqual(await hostMcpServers({ HOME: dir }, "/repo"), {});
});

test("credentials in host settings yield a warning naming the key, never its value (R14)", async () => {
  const dir = await temp();
  await mkdir(join(dir, ".claude"));
  const settings = join(dir, ".claude", "settings.json");
  await writeFile(
    settings,
    JSON.stringify({
      apiKeyHelper: "/bin/print-key",
      env: { ANTHROPIC_API_KEY: "sk-ant-fixture-value", EDITOR: "vim" },
    }),
  );
  const warning = await credentialWarning({ HOME: dir });
  assert.match(warning ?? "", /apiKeyHelper/);
  assert.match(warning ?? "", /env\.ANTHROPIC_API_KEY/);
  assert.doesNotMatch(warning ?? "", /sk-ant-fixture-value|print-key|EDITOR/);
  await writeFile(settings, JSON.stringify({ model: "sonnet" }));
  assert.equal(await credentialWarning({ HOME: dir }), undefined);
});

async function hostSession(folder: string) {
  const dir = await temp();
  const id = randomUUID();
  const projects = join(dir, ".claude", "projects", folder);
  await mkdir(join(projects, id, "subagents"), { recursive: true });
  await writeFile(join(projects, `${id}.jsonl`), '{"type":"user"}\n');
  await writeFile(join(projects, id, "subagents", "agent.jsonl"), "{}\n");
  const home = join(dir, "accounts", "claude");
  await mkdir(home, { recursive: true });
  return { dir, id, home, projects };
}

test("a pre-upgrade session is copied with its folder on first resume, once (AE6)", async () => {
  // Dots and truncation in a project folder name do not matter: the session is found by scan.
  const { dir, id, home } = await hostSession("-Users-me-my.repo-trunc");
  assert.equal(await migrateSession({ HOME: dir }, home, id), true);
  const target = join(home, "projects", "-Users-me-my.repo-trunc");
  assert.equal(
    await readFile(join(target, `${id}.jsonl`), "utf8"),
    '{"type":"user"}\n',
  );
  assert.equal(
    await readFile(join(target, id, "subagents", "agent.jsonl"), "utf8"),
    "{}\n",
  );
  assert.equal(await migrateSession({ HOME: dir }, home, id), false);
  assert.ok((await readdir(target)).every((name) => !name.endsWith(".tmp")));
});

test("session ids that are not UUIDs and symlinked host entries are never copied", async () => {
  const { dir, id, home, projects } = await hostSession("-repo");
  assert.equal(await migrateSession({ HOME: dir }, home, `../${id}`), false);
  // A symlinked file inside the session folder is skipped.
  await writeFile(join(dir, "outside.txt"), "outside");
  await symlink(join(dir, "outside.txt"), join(projects, id, "link.txt"));
  // A symlinked project folder is not scanned.
  const other = randomUUID();
  await mkdir(join(dir, "elsewhere"));
  await writeFile(join(dir, "elsewhere", `${other}.jsonl`), "{}");
  await symlink(
    join(dir, "elsewhere"),
    join(dir, ".claude", "projects", "-linked"),
  );
  assert.equal(await migrateSession({ HOME: dir }, home, other), false);
  assert.equal(await migrateSession({ HOME: dir }, home, id), true);
  await assert.rejects(stat(join(home, "projects", "-repo", id, "link.txt")), {
    code: "ENOENT",
  });
  assert.equal(await migrateSession({ HOME: dir }, home, randomUUID()), false);
});

/** A stand-in Claude Code that logs its arguments and CLAUDE_CONFIG_DIR, then acts per $MODE. */
async function stubClaude() {
  const dir = await temp();
  const log = join(dir, "calls.log");
  const pid = join(dir, "pid");
  const executable = join(dir, "claude");
  await writeFile(
    executable,
    `#!/bin/sh
echo "$* config=$CLAUDE_CONFIG_DIR token=\${CLAUDE_CODE_OAUTH_TOKEN:-none}" >> "${log}"
echo $$ > "${pid}"
case "$MODE" in
  fail) echo "Opening browser to sign in"; echo "Login failed: invalid_grant" >&2; exit 1 ;;
  hang) exec sleep 30 ;;
  *) exit 0 ;;
esac
`,
  );
  await chmod(executable, 0o755);
  const env = (mode: string) => ({
    PATH: process.env.PATH ?? "",
    MODE: mode,
    CLAUDE_CONFIG_DIR: join(dir, "app-home"),
  });
  return {
    executable,
    env,
    calls: async () => (await readFile(log, "utf8")).trim().split("\n"),
    pid: async () => Number(await readFile(pid, "utf8")),
    dir,
  };
}

test("the login runs Claude Code's own auth login in the app home and reports its exit", async () => {
  const stub = await stubClaude();
  await startLogin(stub.executable, stub.env("ok")).done;
  const failing = startLogin(stub.executable, stub.env("fail"));
  await assert.rejects(failing.done, /Login failed: invalid_grant/);
  const calls = await stub.calls();
  assert.equal(
    calls[0],
    `auth login --claudeai config=${join(stub.dir, "app-home")} token=none`,
  );
});

test("cancel kills the login program", async () => {
  const stub = await stubClaude();
  const login = startLogin(stub.executable, stub.env("hang"));
  let pid = 0;
  for (let attempt = 0; attempt < 250 && !pid; attempt++) {
    await wait(20);
    pid = await stub.pid().catch(() => 0);
  }
  assert.ok(pid, "the login program started");
  login.cancel();
  await assert.rejects(login.done, /cancelled/);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("sign-out runs auth logout against the app home", async () => {
  const stub = await stubClaude();
  await logout(stub.executable, stub.env("ok"));
  assert.equal(
    (await stub.calls())[0],
    `auth logout config=${join(stub.dir, "app-home")} token=none`,
  );
});
