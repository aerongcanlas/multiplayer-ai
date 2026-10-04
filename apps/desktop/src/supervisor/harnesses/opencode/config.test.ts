import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTING,
  buildConfig,
  HostConfigs,
  hostedLogin,
  matches,
  type LocalProvider,
} from "./config";
import type { Launcher } from "./process";

const ollama: LocalProvider = {
  id: "ollama",
  name: "Ollama",
  baseURL: "http://127.0.0.1:11434/v1",
  models: [{ id: "qwen3-coder:30b", name: "qwen3-coder:30b", context: 65_536 }],
};
const build = (
  host: Record<string, unknown> = {},
  extra: Partial<Parameters<typeof buildConfig>[0]> = {},
) =>
  buildConfig({
    host,
    providers: [ollama],
    hostedLogin: false,
    env: { HOME: "/home/host" },
    ...extra,
  });
type Rules = Record<string, unknown>;
const agentRules = (built: ReturnType<typeof build>, name: string) =>
  (built.content.agent as Record<string, { permission: Rules }>)[name]!
    .permission;
const modeRules = (built: ReturnType<typeof build>, name: string) =>
  (built.content.mode as Record<string, { permission: Rules }> | undefined)?.[
    name
  ]?.permission;

/** The action OpenCode would take: the last matching rule in an ordered block. */
function decide(rules: Rules, key: string, input: string) {
  let action = "ask";
  for (const [permission, value] of Object.entries(rules)) {
    if (!matches(key, permission)) continue;
    if (typeof value === "string") action = value;
    else
      for (const [pattern, choice] of Object.entries(value as Rules))
        if (matches(input, pattern)) action = choice as string;
  }
  return action;
}

test("every acting key asks, read-only keys keep OpenCode's rules, and task is denied", () => {
  const built = build();
  const top = built.content.permission as Rules;
  for (const key of ACTING) {
    assert.equal(top[key], "ask");
    assert.equal(decide(built.permission, key, "anything"), "ask");
    assert.equal(decide(agentRules(built, "build"), key, "anything"), "ask");
  }
  assert.equal(top.task, "deny");
  assert.equal(agentRules(built, "build").task, "deny");
  for (const key of ["read", "grep", "glob", "list", "lsp"]) {
    assert.equal(key in top, false);
    assert.equal(key in agentRules(built, "build"), false);
  }
  // The second stage carries the ordered rules as JSON in its own variable.
  assert.deepEqual(JSON.parse(built.env.OPENCODE_PERMISSION), built.permission);
  assert.deepEqual(
    JSON.parse(built.env.OPENCODE_CONFIG_CONTENT),
    built.content,
  );
});

test("a host deny survives at the top level and inside an agent", () => {
  const built = build({
    permission: { bash: { "*": "allow", "rm *": "deny" }, edit: "allow" },
    agent: { build: { permission: { edit: { "secrets/*": "deny" } } } },
  });
  assert.equal(decide(built.permission, "bash", "rm -rf build"), "deny");
  assert.equal(decide(built.permission, "bash", "ls"), "ask");
  assert.equal(decide(built.permission, "edit", "a.ts"), "ask");
  const agent = agentRules(built, "build");
  assert.equal(decide(agent, "bash", "rm -rf build"), "deny");
  assert.equal(decide(agent, "bash", "git status"), "ask");
  // A key the host agent already holds keeps its position, so its rules go through `mode`.
  assert.equal(agent.edit, "ask");
  const second = modeRules(built, "build")!;
  assert.equal(decide(second, "edit", "secrets/key.pem"), "deny");
  assert.equal(decide(second, "edit", "src/a.ts"), "ask");
});

test("a host build agent that allows shell still asks (AE7)", () => {
  const built = build({ agent: { build: { permission: { bash: "allow" } } } });
  assert.equal(decide(agentRules(built, "build"), "bash", "ls"), "ask");
});

test("plan mode stays read-only apart from OpenCode's plan files", () => {
  const plan = agentRules(build({ permission: { edit: "allow" } }), "plan");
  assert.equal(decide(plan, "edit", "src/a.ts"), "deny");
  assert.equal(decide(plan, "edit", ".opencode/plans/next.md"), "ask");
});

test("MCP tools of host servers ask, and a host deny on one tool stays", () => {
  const built = build({
    mcp: { "my.srv": { type: "local", command: ["x"] } },
    permission: { my_srv_drop: "deny", "my_srv_*": "allow" },
  });
  const agent = agentRules(built, "build");
  assert.equal(decide(agent, "my_srv_read", "*"), "ask");
  assert.equal(decide(agent, "my_srv_drop", "*"), "deny");
});

test("rules masked by `debug config` are kept as denies", () => {
  const built = build({ permission: { edit: { "secret/*": "***" } } });
  assert.equal(decide(built.permission, "edit", "secret/a"), "deny");
  assert.equal(decide(built.permission, "edit", "src/a"), "ask");
});

test("local providers the host does not define are injected with their served context (AE2)", () => {
  const injected = build().content.provider as Record<string, Rules>;
  assert.deepEqual(Object.keys(injected), ["ollama"]);
  assert.deepEqual((injected.ollama!.models as Rules)["qwen3-coder:30b"], {
    name: "qwen3-coder:30b",
    tool_call: true,
    limit: { context: 65_536, output: 16_384 },
  });
  const host = build({ provider: { ollama: { models: { mine: {} } } } });
  assert.equal(host.content.provider, undefined);
});

test("the model is set only when the host sets none, and the saved default wins", () => {
  assert.equal(build().content.model, "ollama/qwen3-coder:30b");
  assert.equal(
    build({}, { defaultModel: "anthropic/claude-sonnet" }).content.model,
    "anthropic/claude-sonnet",
  );
  assert.equal(build({ model: "openai/gpt" }).content.model, undefined);
  // Titles and summaries use a local model whenever one exists.
  assert.equal(
    build({}, { defaultModel: "anthropic/claude-sonnet" }).content.small_model,
    "ollama/qwen3-coder:30b",
  );
  assert.equal(
    build({}, { providers: [], defaultModel: "anthropic/claude-sonnet" })
      .content.small_model,
    "anthropic/claude-sonnet",
  );
});

test("OpenCode's hosted provider is disabled without its login, keeping the host's list", () => {
  assert.deepEqual(
    build({ disabled_providers: ["groq"] }).content.disabled_providers,
    ["groq", "opencode"],
  );
  assert.equal(
    build({}, { hostedLogin: true }).content.disabled_providers,
    undefined,
  );
});

test("a different host config or local model list changes the config hash", () => {
  assert.equal(build().hash, build().hash);
  assert.notEqual(build().hash, build({ model: "x/y" }).hash);
  assert.notEqual(build().hash, build({}, { providers: [] }).hash);
});

test("the OpenCode login is read from its data folder", async () => {
  const home = await mkdtemp(join(tmpdir(), "multiplayer-opencode-auth-"));
  const env = { XDG_DATA_HOME: join(home, "data") };
  assert.equal(await hostedLogin(env), false);
  await mkdir(join(home, "data", "opencode"), { recursive: true });
  await writeFile(
    join(home, "data", "opencode", "auth.json"),
    JSON.stringify({ anthropic: { type: "oauth" } }),
  );
  assert.equal(await hostedLogin(env), false);
  await writeFile(
    join(home, "data", "opencode", "auth.json"),
    JSON.stringify({ opencode: { type: "api", key: "k" } }),
  );
  assert.equal(await hostedLogin(env), true);
});

test("a project's own provider suppresses injection only for tabs in that project", async () => {
  const fixture = fileURLToPath(
    new URL("../../../../scripts/opencode-fixture.mjs", import.meta.url),
  );
  const launcher: Launcher = (_executable, args, env) => ({
    executable: process.execPath,
    args: [fixture, ...args],
    env,
  });
  const root = await mkdtemp(join(tmpdir(), "multiplayer-opencode-host-"));
  const [project, other] = [join(root, "project"), join(root, "other")];
  await mkdir(project);
  await mkdir(other);
  await writeFile(
    join(project, "opencode.json"),
    JSON.stringify({ provider: { ollama: { models: { mine: {} } } } }),
  );
  const configs = new HostConfigs(launcher);
  const context = {
    executable: "/opt/opencode",
    env: { PATH: process.env.PATH ?? "" },
  };
  const inProject = await configs.get(context, project);
  const elsewhere = await configs.get(context, other);
  assert.equal(build(inProject).content.provider, undefined);
  assert.deepEqual(Object.keys(build(elsewhere).content.provider as Rules), [
    "ollama",
  ]);
  // Cached per folder until cleared.
  assert.equal(await configs.get(context, project), inProject);
  configs.clear();
  assert.notEqual(await configs.get(context, project), inProject);
});
