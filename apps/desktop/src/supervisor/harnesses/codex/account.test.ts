import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_ACCOUNT } from "./account";
import { Accounts } from "../accounts";

test("the Codex home links the host's setup and never its login or sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "multiplayer-codex-account-"));
  const host = join(dir, "custom-codex");
  for (const name of ["skills", "prompts", "rules", "plugins", "sessions"])
    await mkdir(join(host, name), { recursive: true });
  await writeFile(join(host, "config.toml"), 'model = "gpt-5.5"\n');
  await writeFile(join(host, "AGENTS.md"), "instructions");
  await writeFile(join(host, "auth.json"), "{}");
  const accounts = new Accounts(join(dir, "accounts"));
  const home = await accounts.prepare("codex", CODEX_ACCOUNT, {
    HOME: dir,
    CODEX_HOME: host,
  });
  assert.deepEqual((await readdir(home)).sort(), [
    ".multiplayer-links.json",
    "AGENTS.md",
    "config.toml",
    "plugins",
    "prompts",
    "rules",
    "skills",
  ]);
  assert.equal(
    await readlink(join(home, "config.toml")),
    join(host, "config.toml"),
  );
});
