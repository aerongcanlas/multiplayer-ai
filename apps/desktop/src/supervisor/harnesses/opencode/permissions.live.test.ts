// Checks the injected permission rules against a real OpenCode binary: `OPENCODE_LIVE_BINARY`
// names it (the live check sets it). Each case writes a host config to a scratch OpenCode home,
// reads OpenCode's resolved config, injects ours, and evaluates the rules OpenCode reports for an
// agent with `opencode debug agent`. Skipped without the variable.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, matches } from "./config";

const binary = process.env.OPENCODE_LIVE_BINARY;
type Rule = { permission: string; pattern: string; action: string };

function host(config: object) {
  const root = mkdtempSync(join(tmpdir(), "multiplayer-opencode-rules-"));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
  };
  mkdirSync(join(root, "config", "opencode"), { recursive: true });
  mkdirSync(join(root, "project"));
  writeFileSync(
    join(root, "config", "opencode", "opencode.json"),
    JSON.stringify(config),
  );
  const cwd = join(root, "project");
  const run = (args: string[], extra: Record<string, string>) => {
    const output = execFileSync(binary!, args, {
      cwd,
      env: { ...env, ...extra },
      encoding: "utf8",
    });
    return JSON.parse(output.slice(output.indexOf("{")));
  };
  const built = buildConfig({
    host: run(["debug", "config"], { OPENCODE_CONFIG_CONTENT: "{}" }),
    // `debug agent` needs a provider; a local one keeps the check offline.
    providers: [
      {
        id: "ollama",
        name: "Ollama",
        baseURL: "http://127.0.0.1:11434/v1",
        models: [{ id: "fixture", name: "fixture" }],
      },
    ],
    hostedLogin: false,
    env,
  });
  const agents = new Map<string, Rule[]>();
  return (agent: string, permission: string, input: string) => {
    if (!agents.has(agent))
      agents.set(agent, run(["debug", "agent", agent], built.env).permission);
    return (
      agents
        .get(agent)!
        .findLast(
          (rule) =>
            matches(permission, rule.permission) &&
            matches(input, rule.pattern),
        )?.action ?? "ask"
    );
  };
}

const live = { skip: !binary && "set OPENCODE_LIVE_BINARY to a real opencode" };

test(
  "acting tools ask, reads stay allowed, task is denied, and a host deny wins (AE5)",
  live,
  () => {
    const decide = host({
      permission: { bash: { "*": "allow", "rm *": "deny" }, edit: "allow" },
    });
    assert.equal(decide("build", "bash", "rm -rf build"), "deny");
    assert.equal(decide("build", "bash", "ls"), "ask");
    assert.equal(decide("build", "edit", "src/a.ts"), "ask");
    assert.equal(decide("build", "webfetch", "https://example.com"), "ask");
    assert.equal(decide("build", "external_directory", "/etc/*"), "ask");
    assert.equal(decide("build", "read", "src/a.ts"), "allow");
    assert.equal(decide("build", "read", "x.env"), "ask");
    assert.equal(decide("build", "task", "general"), "deny");
    assert.equal(decide("plan", "edit", "src/a.ts"), "deny");
    assert.equal(decide("plan", "bash", "rm x"), "deny");
  },
);

test(
  "an agent-level allow still asks and an agent-level deny stays (AE7)",
  live,
  () => {
    const decide = host({
      agent: {
        build: { permission: { bash: "allow" } },
        mine: {
          mode: "primary",
          description: "A host agent",
          permission: { bash: { "rm *": "deny", "*": "allow" } },
        },
      },
    });
    assert.equal(decide("build", "bash", "ls"), "ask");
    assert.equal(decide("mine", "bash", "rm x"), "deny");
    assert.equal(decide("mine", "bash", "ls"), "ask");
  },
);

test(
  "allow-everything and wildcard host configs still ask; MCP denies stay",
  live,
  () => {
    const everything = host({ permission: "allow" });
    assert.equal(everything("build", "bash", "ls"), "ask");
    assert.equal(everything("build", "glob", "*"), "allow");
    const late = host({ permission: { bash: "allow", "*": "allow" } });
    assert.equal(late("build", "bash", "ls"), "ask");
    assert.equal(late("build", "read", "a.ts"), "allow");
    const mcp = host({
      mcp: { "my-srv": { type: "local", command: ["true"], enabled: false } },
      permission: { "my-srv_drop": "deny", "my-srv_*": "allow" },
    });
    assert.equal(mcp("build", "my-srv_read", "*"), "ask");
    assert.equal(mcp("build", "my-srv_drop", "*"), "deny");
  },
);
