import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "./accounts";
import { HarnessRegistry } from "./registry";
import { FakeHarness } from "./fake";
import { ProgramManager } from "../programs/manager";
import { HARNESS_MANIFEST } from "../programs/manifest";

async function registry(
  adapters: FakeHarness[],
  options: { accounts?: (root: string) => Accounts; custom?: boolean } = {},
) {
  const settings = new Map<string, unknown>();
  const root = await mkdtemp(join(tmpdir(), "multiplayer-registry-"));
  if (options.custom)
    for (const adapter of adapters)
      settings.set(`harness.${adapter.id}.executable`, process.execPath);
  return new HarnessRegistry({
    adapters,
    programs: new ProgramManager({ root, manifest: HARNESS_MANIFEST }),
    accounts: options.accounts?.(root) ?? new Accounts(join(root, "accounts")),
    settings: {
      getSetting: <T>(key: string) => settings.get(key) as T | undefined,
      setSetting: (key, value) => settings.set(key, value),
    },
    changed: () => {},
    environmentTimeoutMs: 0,
  });
}

test("a registry without OpenCode reports and offers only its own harnesses", async () => {
  const harnesses = await registry([
    new FakeHarness("codex"),
    new FakeHarness("claude", { signIn: "guidance" }),
  ]);
  try {
    assert.deepEqual(
      harnesses.snapshot().map((state) => state.id),
      ["codex", "claude"],
    );
    assert.throws(() => harnesses.state("opencode"), /not available/);
    assert.equal(harnesses.newTabHarness(), "claude");
    assert.throws(
      () => harnesses.setNewTabHarness("opencode"),
      /not available/,
    );
  } finally {
    harnesses.close();
  }
});

test("only a harness with a notice starts with it pending", async () => {
  const harnesses = await registry([
    new FakeHarness("claude", { signIn: "guidance" }),
    new FakeHarness("opencode", { signIn: "guidance" }),
  ]);
  try {
    assert.equal(harnesses.state("claude").noticePending, true);
    assert.equal(harnesses.state("opencode").noticePending, false);
    assert.equal(harnesses.state("opencode").label, "OpenCode");
  } finally {
    harnesses.close();
  }
});

test("launches name the app's home, never the host's, and link host setup from it", async () => {
  const host = await mkdtemp(join(tmpdir(), "multiplayer-registry-host-"));
  await mkdir(join(host, "skills"));
  const fake = new FakeHarness("claude", {
    account: {
      variable: "CLAUDE_CONFIG_DIR",
      source: (paths) => paths.CLAUDE_CONFIG_DIR!,
      links: ["skills"],
    },
  });
  let root = "";
  const harnesses = await registry([fake], {
    custom: true,
    accounts: (dir) => new Accounts((root = join(dir, "accounts"))),
  });
  harnesses.setEnvironment({
    PATH: "/usr/bin",
    HOME: "/home/host",
    CLAUDE_CONFIG_DIR: host,
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-host",
  });
  try {
    const context = await harnesses.context("claude");
    const home = join(root, "claude");
    assert.equal(context.home, home);
    assert.equal(context.env.CLAUDE_CONFIG_DIR, home);
    assert.equal(context.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.deepEqual(context.hostPaths, {
      HOME: "/home/host",
      CLAUDE_CONFIG_DIR: host,
    });
    assert.equal(await readlink(join(home, "skills")), join(host, "skills"));
  } finally {
    harnesses.close();
  }
});

test("without a usable accounts folder no harness program runs (AE9)", async () => {
  const fake = new FakeHarness("codex");
  const harnesses = await registry([fake], {
    custom: true,
    accounts: () => new Accounts(undefined),
  });
  harnesses.setEnvironment({ PATH: "/usr/bin", HOME: "/home/host" });
  try {
    await assert.rejects(harnesses.context("codex"), /no folder for harness/);
    await harnesses.refresh("codex");
    assert.deepEqual(fake.calls, []);
    const state = harnesses.state("codex");
    assert.equal(state.auth.state, "unknown");
    assert.match(state.auth.message ?? "", /no folder for harness/);
    assert.equal(harnesses.ready("codex"), false);
  } finally {
    harnesses.close();
  }
});
