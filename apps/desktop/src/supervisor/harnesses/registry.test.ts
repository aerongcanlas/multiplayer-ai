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

async function signingIn(options: { timeoutMs?: number } = {}) {
  const fake = new FakeHarness("codex");
  fake.signInMode = "manual";
  const opened: string[] = [];
  const settings = new Map<string, unknown>([
    ["harness.codex.executable", process.execPath],
  ]);
  const root = await mkdtemp(join(tmpdir(), "multiplayer-registry-"));
  const harnesses = new HarnessRegistry({
    adapters: [fake],
    programs: new ProgramManager({ root, manifest: HARNESS_MANIFEST }),
    accounts: new Accounts(join(root, "accounts")),
    settings: {
      getSetting: <T>(key: string) => settings.get(key) as T | undefined,
      setSetting: (key, value) => settings.set(key, value),
    },
    changed: () => {},
    openLogin: (_harness, url) => opened.push(url),
    environmentTimeoutMs: 0,
    signInTimeoutMs: options.timeoutMs,
  });
  harnesses.setEnvironment({ PATH: "/usr/bin", HOME: "/home/host" });
  fake.signedIn = false;
  await harnesses.refresh("codex");
  return { fake, harnesses, opened };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a pending sign-in opens its URL once and signs in when the harness reports success", async () => {
  const { fake, harnesses, opened } = await signingIn();
  try {
    await harnesses.signIn("codex");
    assert.equal(harnesses.state("codex").auth.state, "signing_in");
    assert.deepEqual(opened, ["https://auth.openai.com/fake"]);
    // A second request while one is pending starts nothing.
    await harnesses.signIn("codex");
    assert.equal(fake.calls.filter((call) => call === "startSignIn").length, 1);
    fake.finishSignIn();
    await settle();
    assert.equal(harnesses.state("codex").auth.state, "signed_in");
  } finally {
    harnesses.close();
  }
});

test("a pending sign-in without a URL opens nothing", async () => {
  const { fake, harnesses, opened } = await signingIn();
  try {
    fake.signInUrl = undefined;
    await harnesses.signIn("codex");
    assert.equal(harnesses.state("codex").auth.state, "signing_in");
    assert.deepEqual(opened, []);
  } finally {
    harnesses.close();
  }
});

test("a fresh refresh reads again after a check that started before a sign-out", async () => {
  const { fake, harnesses } = await signingIn();
  try {
    fake.signedIn = true;
    fake.inspectDelayMs = 50;
    void harnesses.refresh("codex");
    await settle();
    fake.signedIn = false;
    await harnesses.refresh("codex", true);
    assert.equal(harnesses.state("codex").auth.state, "signed_out");
  } finally {
    harnesses.close();
  }
});

test("cancel and timeout end the sign-in and return to signed out (AE4)", async () => {
  const cancelled = await signingIn();
  try {
    await cancelled.harnesses.signIn("codex");
    await cancelled.harnesses.cancelSignIn("codex");
    assert.ok(cancelled.fake.calls.includes("cancelSignIn"));
    assert.equal(cancelled.harnesses.state("codex").auth.state, "signed_out");
    // The cancelled program finishing later changes nothing.
    cancelled.fake.finishSignIn();
    await settle();
    assert.equal(cancelled.harnesses.state("codex").auth.state, "signed_out");
  } finally {
    cancelled.harnesses.close();
  }
  const timed = await signingIn({ timeoutMs: 30 });
  try {
    await timed.harnesses.signIn("codex");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(timed.harnesses.state("codex").auth, {
      state: "signed_out",
      message: "Sign-in timed out.",
    });
    assert.ok(timed.fake.calls.includes("cancelSignIn"));
  } finally {
    timed.harnesses.close();
  }
});

test("a failed sign-in keeps a redacted, capped reason", async () => {
  const { fake, harnesses } = await signingIn();
  try {
    fake.signInError = `Login failed\nError at https://auth.example/callback?code=abc: token sk-ant-oat01-${"x".repeat(40)}9 rejected ${"y".repeat(300)}`;
    await harnesses.signIn("codex");
    const message = harnesses.state("codex").auth.message ?? "";
    assert.equal(harnesses.state("codex").auth.state, "signed_out");
    assert.ok(message.length <= 200);
    assert.doesNotMatch(message, /https:|sk-ant|Login failed/);
    assert.match(message, /\[link\]/);
    assert.match(message, /\[redacted\]/);
    // A program that fails after starting is recorded the same way.
    fake.signInError = undefined;
    await harnesses.signIn("codex");
    fake.finishSignIn("The browser sign-in was declined.");
    await settle();
    assert.deepEqual(harnesses.state("codex").auth, {
      state: "signed_out",
      message: "The browser sign-in was declined.",
    });
  } finally {
    harnesses.close();
  }
});

test("closing the registry ends a pending sign-in", async () => {
  const { fake, harnesses } = await signingIn();
  await harnesses.signIn("codex");
  harnesses.close();
  await settle();
  assert.ok(fake.calls.includes("cancelSignIn"));
});

test("without a usable accounts folder sign-out runs nothing (AE9)", async () => {
  const fake = new FakeHarness("codex");
  const harnesses = await registry([fake], {
    custom: true,
    accounts: () => new Accounts(undefined),
  });
  harnesses.setEnvironment({ PATH: "/usr/bin", HOME: "/home/host" });
  try {
    await assert.rejects(
      harnesses.prepareSignOut("codex"),
      /no folder for harness/,
    );
    assert.ok(!fake.calls.some((call) => call.startsWith("signOut")));
  } finally {
    harnesses.close();
  }
});

test("a host who acknowledged the old Claude notice sees the new one once", async () => {
  const settings = new Map<string, unknown>([
    ["harness.claude.noticeAcknowledged", true],
  ]);
  const root = await mkdtemp(join(tmpdir(), "multiplayer-registry-"));
  const harnesses = new HarnessRegistry({
    adapters: [new FakeHarness("claude")],
    programs: new ProgramManager({ root, manifest: HARNESS_MANIFEST }),
    accounts: new Accounts(join(root, "accounts")),
    settings: {
      getSetting: <T>(key: string) => settings.get(key) as T | undefined,
      setSetting: (key, value) => settings.set(key, value),
    },
    changed: () => {},
    environmentTimeoutMs: 0,
  });
  try {
    assert.equal(harnesses.state("claude").noticePending, true);
    harnesses.acknowledgeNotice("claude");
    assert.equal(settings.get("harness.claude.noticeAcknowledged.v2"), true);
  } finally {
    harnesses.close();
  }
});
