import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginCommand } from "./account";

const AWKWARD = "my home $HOME `id` it's 100%";

test("the login command quotes an awkward program path for zsh and bash", async () => {
  const dir = join(
    await mkdtemp(join(tmpdir(), "multiplayer-opencode-cmd-")),
    AWKWARD,
  );
  await mkdir(dir, { recursive: true });
  const executable = join(dir, "opencode");
  await writeFile(executable, '#!/bin/sh\nprintf "%s %s" "$1" "$2"\n');
  await chmod(executable, 0o755);
  const command = loginCommand(executable, "darwin");
  for (const shell of ["/bin/sh", "/bin/bash", "/bin/zsh"])
    assert.equal(
      execFileSync(shell, ["-c", command], { encoding: "utf8" }),
      "auth login",
      shell,
    );
});

test("the login command quotes an awkward program path for PowerShell", () => {
  assert.equal(
    loginCommand(`C:\\Users\\me\\${AWKWARD}\\opencode.exe`, "win32"),
    "& 'C:\\Users\\me\\my home $HOME `id` it''s 100%\\opencode.exe' auth login",
  );
});
