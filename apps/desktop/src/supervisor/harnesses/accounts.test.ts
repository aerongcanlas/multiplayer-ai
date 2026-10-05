import test from "node:test";
import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountError,
  Accounts,
  assertHome,
  hostPaths,
  type AccountSpec,
} from "./accounts";

const SPEC: AccountSpec = {
  variable: "CLAUDE_CONFIG_DIR",
  source: (host) => host.CLAUDE_CONFIG_DIR ?? join(host.HOME!, ".claude"),
  links: ["skills", "agents", "settings.json", "CLAUDE.md"],
  projectMemory: true,
};

async function setup(platform: NodeJS.Platform = "darwin") {
  const dir = await mkdtemp(join(tmpdir(), "multiplayer-accounts-"));
  const source = join(dir, "host", ".claude");
  await mkdir(join(source, "skills", "foo"), { recursive: true });
  await writeFile(join(source, "skills", "foo", "SKILL.md"), "foo");
  await writeFile(join(source, "settings.json"), '{"model":"sonnet"}');
  await mkdir(join(source, "projects", "-repo-a", "memory"), {
    recursive: true,
  });
  await writeFile(
    join(source, "projects", "-repo-a", "memory", "MEMORY.md"),
    "m",
  );
  // A host transcript beside the memory folder never carries over.
  await writeFile(join(source, "projects", "-repo-a", "session.jsonl"), "{}");
  const accounts = new Accounts(join(dir, "accounts"), platform);
  const host = { HOME: join(dir, "host") };
  const home = join(dir, "accounts", "claude");
  const manifest = async () =>
    JSON.parse(
      await readFile(join(home, ".multiplayer-links.json"), "utf8"),
    ) as {
      entries: Record<string, { kind: string; target: string; hash?: string }>;
    };
  return { dir, source, accounts, host, home, manifest };
}

test("host setup is linked into the home, and a second prepare changes nothing (AE3)", async () => {
  const { source, accounts, host, home, manifest } = await setup();
  assert.equal(await accounts.prepare("claude", SPEC, host), home);
  assert.equal(await readlink(join(home, "skills")), join(source, "skills"));
  assert.equal(
    await readlink(join(home, "settings.json")),
    join(source, "settings.json"),
  );
  assert.equal(
    await readlink(join(home, "projects", "-repo-a", "memory")),
    join(source, "projects", "-repo-a", "memory"),
  );
  assert.deepEqual(await readdir(join(home, "projects", "-repo-a")), [
    "memory",
  ]);
  // CLAUDE.md and agents/ do not exist on the host, so nothing is made for them.
  assert.deepEqual(Object.keys((await manifest()).entries).sort(), [
    "projects/-repo-a/memory",
    "settings.json",
    "skills",
  ]);
  const before = await manifest();
  const linked = (await lstat(join(home, "skills"))).mtimeMs;
  await accounts.prepare("claude", SPEC, host);
  assert.deepEqual(await manifest(), before);
  assert.equal((await lstat(join(home, "skills"))).mtimeMs, linked);
});

test("a host CLAUDE_CONFIG_DIR is the carry-over source", async () => {
  const { dir, accounts, home } = await setup();
  const custom = join(dir, "custom");
  await mkdir(join(custom, "skills"), { recursive: true });
  await accounts.prepare("claude", SPEC, {
    HOME: dir,
    CLAUDE_CONFIG_DIR: custom,
  });
  assert.equal(await readlink(join(home, "skills")), join(custom, "skills"));
  assert.deepEqual(
    hostPaths({
      CLAUDE_CONFIG_DIR: custom,
      ANTHROPIC_API_KEY: "sk",
      HOME: dir,
    }),
    { HOME: dir, CLAUDE_CONFIG_DIR: custom },
  );
});

test("later host additions are linked and removed host entries are unlinked", async () => {
  const { source, accounts, host, home, manifest } = await setup();
  await accounts.prepare("claude", SPEC, host);
  await mkdir(join(source, "agents"));
  await rm(join(source, "skills"), { recursive: true });
  await accounts.prepare("claude", SPEC, host);
  assert.equal(await readlink(join(home, "agents")), join(source, "agents"));
  await assert.rejects(lstat(join(home, "skills")), { code: "ENOENT" });
  assert.ok(!("skills" in (await manifest()).entries));
});

test("a link the harness replaced with a real file is backed up and re-linked (AE8)", async () => {
  const { source, accounts, host, home } = await setup();
  await accounts.prepare("claude", SPEC, host);
  const hostFile = join(source, "settings.json");
  const hostBefore = await stat(hostFile);
  await rm(join(home, "settings.json"));
  await writeFile(join(home, "settings.json"), '{"model":"opus"}');
  await accounts.prepare("claude", SPEC, host);
  assert.equal(await readlink(join(home, "settings.json")), hostFile);
  const backups = (await readdir(home)).filter((name) =>
    /^settings\.json\.app-.+\.bak$/.test(name),
  );
  assert.equal(backups.length, 1);
  assert.equal(
    await readFile(join(home, backups[0]!), "utf8"),
    '{"model":"opus"}',
  );
  const hostAfter = await stat(hostFile);
  assert.equal(await readFile(hostFile, "utf8"), '{"model":"sonnet"}');
  assert.equal(hostAfter.mtimeMs, hostBefore.mtimeMs);
});

test("a real file the harness made itself is never touched", async () => {
  const { source, accounts, host, home, manifest } = await setup();
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "CLAUDE.md"), "the harness's own");
  await writeFile(join(source, "CLAUDE.md"), "host");
  await accounts.prepare("claude", SPEC, host);
  assert.equal(
    await readFile(join(home, "CLAUDE.md"), "utf8"),
    "the harness's own",
  );
  assert.ok(!("CLAUDE.md" in (await manifest()).entries));
  await writeFile(join(home, "history.jsonl"), "{}");
  await accounts.prepare("claude", SPEC, host);
  assert.equal(await readFile(join(home, "history.jsonl"), "utf8"), "{}");
  assert.ok(!("history.jsonl" in (await manifest()).entries));
});

test("on Windows folders become junctions and files become refreshed copies", async () => {
  const { source, accounts, host, home, manifest } = await setup("win32");
  await accounts.prepare("claude", SPEC, host);
  let entries = (await manifest()).entries;
  assert.equal(entries.skills?.kind, "junction");
  assert.equal(entries["projects/-repo-a/memory"]?.kind, "junction");
  assert.equal(entries["settings.json"]?.kind, "copy");
  assert.ok((await lstat(join(home, "settings.json"))).isFile());

  // An unchanged copy follows a newer host file.
  await writeFile(join(source, "settings.json"), '{"model":"haiku"}');
  await accounts.prepare("claude", SPEC, host);
  assert.equal(
    await readFile(join(home, "settings.json"), "utf8"),
    '{"model":"haiku"}',
  );
  assert.equal(
    (await readdir(home)).filter((name) => name.endsWith(".bak")).length,
    0,
  );

  // A copy the harness changed is kept aside before the refresh.
  await writeFile(join(home, "settings.json"), '{"model":"tab-choice"}');
  await accounts.prepare("claude", SPEC, host);
  const backups = (await readdir(home)).filter((name) => name.endsWith(".bak"));
  assert.equal(backups.length, 1);
  assert.equal(
    await readFile(join(home, backups[0]!), "utf8"),
    '{"model":"tab-choice"}',
  );
  assert.equal(
    await readFile(join(home, "settings.json"), "utf8"),
    '{"model":"haiku"}',
  );
  entries = (await manifest()).entries;
  assert.ok(entries["settings.json"]?.hash);
  assert.equal(
    await readFile(join(source, "settings.json"), "utf8"),
    '{"model":"haiku"}',
  );
});

test("a spec's copies are copied on every platform", async () => {
  const { source, accounts, host, home } = await setup();
  const spec = { ...SPEC, links: ["skills"], copies: ["settings.json"] };
  await accounts.prepare("claude", spec, host);
  assert.ok((await lstat(join(home, "settings.json"))).isFile());
  await utimes(join(source, "settings.json"), new Date(), new Date());
  await writeFile(join(source, "settings.json"), '{"model":"opus"}');
  await accounts.prepare("claude", spec, host);
  assert.equal(
    await readFile(join(home, "settings.json"), "utf8"),
    '{"model":"opus"}',
  );
});

test("an unchanged copy's manifest entry follows a moved host folder", async () => {
  const { dir, source, accounts, host, manifest } = await setup();
  const spec = { ...SPEC, links: [], copies: ["settings.json"] };
  await accounts.prepare("claude", spec, host);
  const moved = join(dir, "moved");
  await mkdir(moved, { recursive: true });
  await writeFile(join(moved, "settings.json"), '{"model":"sonnet"}');
  await accounts.prepare("claude", spec, { ...host, CLAUDE_CONFIG_DIR: moved });
  const entry = (await manifest()).entries["settings.json"];
  assert.equal(entry?.target, join(moved, "settings.json"));
  assert.notEqual(entry?.target, join(source, "settings.json"));
});

test("concurrent prepares of one home both resolve with one consistent manifest", async () => {
  const { accounts, host, home, manifest } = await setup();
  const [first, second] = await Promise.all([
    accounts.prepare("claude", SPEC, host),
    accounts.prepare("claude", SPEC, host),
  ]);
  assert.equal(first, home);
  assert.equal(second, home);
  assert.equal(Object.keys((await manifest()).entries).length, 3);
  // A second app instance on the same root converges as well.
  const other = new Accounts(join(home, ".."));
  await Promise.all([
    other.prepare("claude", SPEC, host),
    accounts.prepare("claude", SPEC, host),
  ]);
  assert.equal(Object.keys((await manifest()).entries).length, 3);
});

test("a host folder that is the app's own home links nothing", async () => {
  const { dir, accounts, home } = await setup();
  await mkdir(join(home, "skills"), { recursive: true });
  await accounts.prepare("claude", SPEC, {
    HOME: dir,
    CLAUDE_CONFIG_DIR: home,
  });
  assert.ok((await lstat(join(home, "skills"))).isDirectory());
  await assert.rejects(readFile(join(home, ".multiplayer-links.json")), {
    code: "ENOENT",
  });
});

test("credential and transcript names are never linked, even when listed", async () => {
  const { source, accounts, host, home, manifest } = await setup();
  for (const name of [".credentials.json", ".claude.json", "auth.json"])
    await writeFile(join(source, name), "secret");
  await mkdir(join(source, "sessions"));
  await accounts.prepare(
    "claude",
    {
      ...SPEC,
      links: [
        ".credentials.json",
        ".claude.json",
        "auth.json",
        "sessions",
        "projects",
        "../escape",
      ],
      copies: [".credentials.json"],
    },
    host,
  );
  assert.deepEqual(Object.keys((await manifest()).entries), [
    "projects/-repo-a/memory",
  ]);
  for (const name of [
    ".credentials.json",
    ".claude.json",
    "auth.json",
    "sessions",
  ])
    await assert.rejects(lstat(join(home, name)), { code: "ENOENT" });
});

test(
  "homes are private to the user on POSIX",
  { skip: process.platform === "win32" },
  async () => {
    const { accounts, host, home } = await setup();
    await accounts.prepare("claude", SPEC, host);
    assert.equal((await stat(home)).mode & 0o777, 0o700);
  },
);

test("without a root, or when the home cannot be made, prepare fails closed (AE9)", async () => {
  const { dir, host } = await setup();
  await assert.rejects(
    new Accounts(undefined).prepare("claude", SPEC, host),
    AccountError,
  );
  // A file where the root folder should be.
  await writeFile(join(dir, "blocked"), "");
  await assert.rejects(
    new Accounts(join(dir, "blocked")).prepare("claude", SPEC, host),
    AccountError,
  );
});

test("a launch environment must name the prepared home under the root", async () => {
  const accounts = new Accounts("/app/accounts");
  const home = "/app/accounts/claude";
  assertHome(
    { env: { CLAUDE_CONFIG_DIR: home }, home },
    "CLAUDE_CONFIG_DIR",
    accounts,
  );
  assert.throws(
    () =>
      assertHome(
        { env: { CLAUDE_CONFIG_DIR: "/home/host/.claude" }, home },
        "CLAUDE_CONFIG_DIR",
      ),
    AccountError,
  );
  assert.throws(
    () =>
      assertHome(
        { env: { CLAUDE_CONFIG_DIR: "/elsewhere" }, home: "/elsewhere" },
        "CLAUDE_CONFIG_DIR",
        accounts,
      ),
    AccountError,
  );
});
