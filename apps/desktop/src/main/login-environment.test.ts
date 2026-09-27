import test from "node:test";
import assert from "node:assert/strict";
import { parseEnvironment, resolveLoginEnvironment } from "./login-environment";

test("the login-shell environment is read after startup-file noise", () => {
  assert.deepEqual(
    parseEnvironment(
      "Welcome!\n__MULTIPLAYER_AI_ENV__PATH=/opt/homebrew/bin:/usr/bin\0SSH_AUTH_SOCK=/tmp/agent\0EMPTY=\0MULTI=a=b\0",
    ),
    {
      PATH: "/opt/homebrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/agent",
      EMPTY: "",
      MULTI: "a=b",
    },
  );
  assert.deepEqual(parseEnvironment("no marker"), {});
});

test("Windows and missing shells use the app's own environment", async () => {
  assert.deepEqual(
    await resolveLoginEnvironment({ PATH: "C:\\bin" }, "win32"),
    {
      PATH: "C:\\bin",
    },
  );
  assert.deepEqual(
    await resolveLoginEnvironment({ PATH: "/usr/bin" }, "linux"),
    {
      PATH: "/usr/bin",
    },
  );
});

test(
  "a POSIX login shell supplies its environment",
  { skip: process.platform === "win32" },
  async () => {
    const env = await resolveLoginEnvironment(
      { PATH: "/usr/bin:/bin", SHELL: "/bin/sh", HOME: process.env.HOME },
      process.platform,
    );
    assert.ok(env.PATH);
  },
);
