import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LaunchContext } from "../contract";
import { object, string } from "../json";
import { runCommand, type Launcher } from "./process";

type Action = "allow" | "ask" | "deny";
type Rule = { permission: string; pattern: string; action: Action };
/** A permission block as OpenCode's config holds it: one action, or patterns in evaluation order. */
type Block = Record<string, Action | Record<string, Action>>;

/** A local model server's provider block, as discovery found it. */
export interface LocalProvider {
  id: "ollama" | "lmstudio";
  name: string;
  baseURL: string;
  models: { id: string; name: string; context?: number }[];
}

export interface ConfigInput {
  // OpenCode's own resolved config for the tab's folder (`opencode debug config`).
  host: Record<string, unknown>;
  providers: LocalProvider[];
  // The host's saved default OpenCode model.
  defaultModel?: string;
  // Whether the host is logged in to OpenCode's own hosted provider.
  hostedLogin: boolean;
  env: Record<string, string>;
}

// Every key that can act or reach outside the checkout asks; read-only keys keep OpenCode's rules.
export const ACTING = [
  "edit",
  "bash",
  "webfetch",
  "websearch",
  "codesearch",
  "skill",
  "external_directory",
] as const;
const SINGLE_ACTION = new Set(["webfetch", "websearch"]);
const READ_ONLY: Block = {
  read: {
    "*": "allow",
    "*.env": "ask",
    "*.env.*": "ask",
    "*.env.example": "allow",
  },
  glob: "allow",
  grep: "allow",
  list: "allow",
  lsp: "allow",
  todowrite: "allow",
};

/** OpenCode's pattern match: `*` is any text, `?` one character, and a trailing ` *` optional. */
export function matches(text: string, pattern: string) {
  const value = text.replaceAll("\\", "/");
  let source = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`;
  return new RegExp(
    `^${source}$`,
    process.platform === "win32" ? "si" : "s",
  ).test(value);
}

const ACTIONS = new Set(["allow", "ask", "deny"]);
function block(value: unknown): Block {
  if (typeof value === "string" && ACTIONS.has(value))
    return { "*": value as Action };
  const result: Block = {};
  for (const [key, rule] of Object.entries(object(value))) {
    if (typeof rule === "string" && ACTIONS.has(rule))
      result[key] = rule as Action;
    else if (rule && typeof rule === "object")
      result[key] = Object.fromEntries(
        Object.entries(rule).flatMap(([pattern, action]) =>
          ACTIONS.has(action)
            ? [[pattern, action]]
            : // `debug config` masks values under secret-looking keys; an unknown rule may be a
              // deny, so it is kept as one.
              action === "***"
              ? [[pattern, "deny"]]
              : [],
        ),
      ) as Record<string, Action>;
  }
  return result;
}

const rules = (permission: Block): Rule[] =>
  Object.entries(permission).flatMap(([key, value]) =>
    typeof value === "string"
      ? [{ permission: key, pattern: "*", action: value }]
      : Object.entries(value).map(([pattern, action]) => ({
          permission: key,
          pattern,
          action,
        })),
  );

const wildcard = (key: string) => /[*?]/.test(key);
// OpenCode names an MCP tool `<server>_<tool>`, with other characters replaced.
const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");

/**
 * The rules for one acting key: everything asks, and each host `deny` that covers the key comes
 * after, so it still wins. Host `allow` and `ask` rules become the blanket ask.
 */
function gated(
  key: string,
  host: Rule[],
  start: Record<string, Action> = {},
): Action | Record<string, Action> {
  const result: Record<string, Action> = { "*": "ask", ...start };
  for (const rule of host)
    if (rule.action === "deny" && matches(key, rule.permission)) {
      // A later duplicate replaces the earlier one at the end, as in OpenCode's last-match order.
      delete result[rule.pattern];
      result[rule.pattern] = "deny";
    }
  // OpenCode's schema takes a single action for these keys.
  if (SINGLE_ACTION.has(key)) return result["*"] === "deny" ? "deny" : "ask";
  return result;
}

/** Host keys a wildcard acting key covers more narrowly, such as one tool of an MCP server. */
function narrower(key: string, host: Rule[]) {
  const extra: Record<string, Record<string, Action>> = {};
  for (const rule of host)
    if (
      rule.action === "deny" &&
      rule.permission !== key &&
      wildcard(key) &&
      matches(rule.permission, key)
    )
      // `<key>*` is a new key, so it lands after the blanket ask; it matches the same tool.
      (extra[`${rule.permission}*`] ??= {})[rule.pattern] = "deny";
  return extra;
}

/**
 * Rules that place the blanket ask and host denies in evaluation order. A key the host block
 * already has keeps the host's position, so its gated value goes through a second merge stage.
 */
function agentRules(
  hostBlock: Block,
  keys: string[],
  gatedFor: (key: string) => Action | Record<string, Action>,
  extra: Record<string, Record<string, Action>>,
) {
  const first: Block = {};
  const second: Block = {};
  const order = Object.keys(hostBlock);
  for (const key of keys) {
    const value = gatedFor(key);
    if (typeof hostBlock[key] === "object") {
      first[key] = "ask";
      second[key] = value;
    } else first[key] = value;
  }
  for (const [key, value] of Object.entries(extra))
    if (typeof hostBlock[key] === "object") {
      first[key] = "ask";
      second[key] = value;
    } else first[key] = value;
  // A host wildcard key after an acting key would overrule it, so its allows become asks.
  const firstActing = Math.min(
    ...keys.map((key) => order.indexOf(key)).filter((index) => index >= 0),
  );
  let rewrote = false;
  for (const [index, key] of order.entries()) {
    if (!wildcard(key) || index < firstActing || keys.includes(key)) continue;
    const value = hostBlock[key]!;
    first[key] =
      typeof value === "string"
        ? value === "allow"
          ? "ask"
          : value
        : Object.fromEntries(
            Object.entries(value).map(([pattern, action]) => [
              pattern,
              action === "allow" ? "ask" : action,
            ]),
          );
    rewrote = true;
  }
  if (rewrote)
    for (const [key, value] of Object.entries(READ_ONLY))
      if (!(key in hostBlock)) first[key] = value;
  return { first, second };
}

/** OpenCode's data folder, where its own plans and login live. */
export const dataDir = (env: Record<string, string>) =>
  join(
    env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"),
    "opencode",
  );

/** Whether the host logged in to OpenCode's own hosted provider (`opencode auth login`). */
export async function hostedLogin(env: Record<string, string>) {
  try {
    const auth = JSON.parse(
      await readFile(join(dataDir(env), "auth.json"), "utf8"),
    ) as unknown;
    return Boolean(object(object(auth).opencode).type);
  } catch {
    return false;
  }
}

/**
 * The host's own OpenCode config resolved in each folder, so project config counts as the host's.
 * Results are kept until the next refresh.
 */
export class HostConfigs {
  private cache = new Map<string, Promise<Record<string, unknown>>>();

  constructor(private launcher: Launcher) {}

  get(context: LaunchContext, cwd: string) {
    const key = `${context.executable}\n${cwd}`;
    let config = this.cache.get(key);
    if (!config) {
      config = runCommand(context, this.launcher, ["debug", "config"], {
        cwd,
        // Any config content keeps OpenCode from seeding a global config file.
        config: { OPENCODE_CONFIG_CONTENT: "{}" },
      }).then((output) => {
        const start = output.indexOf("{");
        if (start < 0) throw new Error("OpenCode printed no config.");
        return object(JSON.parse(output.slice(start)));
      });
      this.cache.set(key, config);
      config.catch(() => this.cache.delete(key));
    }
    return config;
  }

  clear() {
    this.cache.clear();
  }
}

/**
 * The config injected into every OpenCode process (KTD5–KTD7): permission rules that keep the
 * tab's access mode, local providers the host does not define, and no silent cloud fallback.
 * `OPENCODE_CONFIG_CONTENT` carries the config; `OPENCODE_PERMISSION` merges last into the
 * top-level rules, so their order is ours.
 */
export function buildConfig(input: ConfigInput) {
  const { host } = input;
  const globalBlock = block(host.permission);
  const globalRules = rules(globalBlock);
  const mcp = Object.keys(object(host.mcp)).map(
    (server) => `${sanitize(server)}_*`,
  );
  const keys = [...ACTING, ...mcp];

  // Top level: strings now, ordered objects in the second stage.
  const permission: Block = { task: "deny" };
  const topLevel: Block = {};
  for (const key of keys) {
    permission[key] = "ask";
    topLevel[key] = gated(key, globalRules);
  }
  for (const key of mcp) Object.assign(topLevel, narrower(key, globalRules));

  const hostAgents = object(host.agent);
  const names = new Set(["build", "plan", ...Object.keys(hostAgents)]);
  const agent: Record<string, unknown> = {};
  const mode: Record<string, unknown> = {};
  const plans = join(dataDir(input.env), "plans", "*");
  for (const name of names) {
    const hostAgent = object(hostAgents[name]);
    if (hostAgent.disable === true) continue;
    const hostBlock = block(hostAgent.permission);
    const combined = [...globalRules, ...rules(hostBlock)];
    const gatedFor = (key: string) => {
      // Plan mode stays read-only apart from OpenCode's own plan files.
      if (name === "plan" && key === "edit")
        return gated(key, combined, {
          "*": "deny",
          "*opencode/plans/*.md": "ask",
        });
      if (name === "plan" && key === "external_directory")
        return gated(key, combined, { [plans]: "allow" });
      return gated(key, combined);
    };
    const extra = Object.assign(
      {},
      ...mcp.map((key) => narrower(key, combined)),
    ) as Record<string, Record<string, Action>>;
    const { first, second } = agentRules(hostBlock, keys, gatedFor, extra);
    agent[name] = { permission: { ...first, task: "deny" } };
    // The mode-to-agent merge makes an agent primary, so a sub-agent keeps one stage.
    if (Object.keys(second).length && string(hostAgent.mode) !== "subagent")
      mode[name] = { permission: second };
  }

  const hostProviders = object(host.provider);
  const provider: Record<string, unknown> = {};
  const local = input.providers.filter((item) => !(item.id in hostProviders));
  for (const item of local)
    provider[item.id] = {
      npm: "@ai-sdk/openai-compatible",
      name: item.name,
      options: { baseURL: item.baseURL },
      models: Object.fromEntries(
        item.models.map((model) => [
          model.id,
          {
            name: model.name,
            tool_call: true,
            ...(model.context
              ? {
                  limit: {
                    context: model.context,
                    output: Math.min(32_768, Math.floor(model.context / 4)),
                  },
                }
              : {}),
          },
        ]),
      ),
    };
  const firstLocal = input.providers
    .flatMap((item) => item.models.map((model) => `${item.id}/${model.id}`))
    .at(0);
  const content: Record<string, unknown> = {
    permission,
    agent,
    ...(Object.keys(mode).length ? { mode } : {}),
    ...(local.length ? { provider } : {}),
  };
  if (!input.hostedLogin) {
    const disabled = Array.isArray(host.disabled_providers)
      ? host.disabled_providers.map(string).filter(Boolean)
      : [];
    content.disabled_providers = [...new Set([...disabled, "opencode"])];
  }
  if (!string(host.model)) {
    const model = input.defaultModel || firstLocal;
    if (model) content.model = model;
  }
  if (!string(host.small_model)) {
    const small = firstLocal ?? input.defaultModel;
    if (small) content.small_model = small;
  }
  const env = {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(content),
    OPENCODE_PERMISSION: JSON.stringify(topLevel),
  };
  const hash = createHash("sha256")
    .update(env.OPENCODE_CONFIG_CONTENT)
    .update("\n")
    .update(env.OPENCODE_PERMISSION)
    .digest("hex")
    .slice(0, 16);
  return { content, permission: topLevel, env, hash };
}
