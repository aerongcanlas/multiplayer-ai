import test from "node:test";
import assert from "node:assert/strict";
import { launchEnvironment } from "./environment";

test("launches never carry the host's Claude OAuth variables or provider keys", () => {
  const env = launchEnvironment({
    PATH: "/usr/bin",
    HOME: "/home/host",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-host",
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "sk-ant-ort-host",
    CLAUDE_CODE_OAUTH_SCOPES: "user:inference",
    CLAUDE_SECURESTORAGE_CONFIG_DIR: "/home/host/.claude",
    ANTHROPIC_API_KEY: "sk-ant-host",
    OPENAI_API_KEY: "sk-host",
    ELECTRON_RUN_AS_NODE: "1",
    UNDEFINED: undefined,
  });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/host" });
});
