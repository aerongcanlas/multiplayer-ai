import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { hostHome, type AccountSpec, type HostPaths } from "../accounts";
import { object } from "../json";

/** The host's own Claude Code folder, where its setup lives. */
const hostClaudeDir = (host: HostPaths) =>
  host.CLAUDE_CONFIG_DIR || join(hostHome(host), ".claude");

/**
 * Claude Code's app home: the host's instructions, skills, agents, commands, output styles, and
 * plugins are linked, per-project memory is linked one level deep, and settings.json is copied,
 * because Claude Code refuses to write settings through a link (KTD4).
 */
export const CLAUDE_ACCOUNT: AccountSpec = {
  variable: "CLAUDE_CONFIG_DIR",
  source: hostClaudeDir,
  links: [
    "CLAUDE.md",
    "skills",
    "agents",
    "commands",
    "output-styles",
    "plugins",
  ],
  copies: ["settings.json"],
  projectMemory: true,
};

/**
 * The host's `.claude.json`, which holds its user and local MCP servers. It sits in
 * CLAUDE_CONFIG_DIR when the host sets one, and in the home folder otherwise (KTD5).
 */
const hostClaudeJson = (host: HostPaths) =>
  join(host.CLAUDE_CONFIG_DIR || hostHome(host), ".claude.json");

/** A JSON file's top-level object; a missing or invalid file gives undefined. */
async function readJson(path: string) {
  try {
    return object(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

const servers = (value: unknown) =>
  Object.fromEntries(
    Object.entries(object(value)).filter(
      ([name, config]) =>
        name.length <= 200 &&
        config !== null &&
        typeof config === "object" &&
        !Array.isArray(config),
    ),
  ) as Record<string, McpServerConfig>;

/**
 * The host's user MCP servers plus its local ones for `cwd`, read-only. Definitions may hold
 * secrets, so they go only to Claude Code; callers log names at most. A missing or invalid file
 * gives none.
 */
export async function hostMcpServers(
  host: HostPaths,
  cwd: string,
): Promise<Record<string, McpServerConfig>> {
  const config = await readJson(hostClaudeJson(host));
  if (!config) return {};
  return {
    ...servers(config.mcpServers),
    ...servers(object(object(config.projects)[resolve(cwd)]).mcpServers),
  };
}

// Settings that make Claude Code use a credential other than the app's sign-in (KTD12).
const CREDENTIAL_SETTINGS = [
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
];
const CREDENTIAL_ENV =
  /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|FOUNDRY_API_KEY)|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)|CLAUDE_CODE_OAUTH_\w+|AWS_(BEARER_TOKEN_BEDROCK|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE)|GOOGLE_APPLICATION_CREDENTIALS)$/;

/**
 * A warning when the host's settings carry a credential that overrides the app's sign-in. It
 * names the setting, never its value.
 */
export async function credentialWarning(host: HostPaths) {
  const settings = await readJson(join(hostClaudeDir(host), "settings.json"));
  if (!settings) return undefined;
  const keys = [
    ...CREDENTIAL_SETTINGS.filter((key) => settings[key] !== undefined),
    ...Object.keys(object(settings.env))
      .filter((key) => CREDENTIAL_ENV.test(key))
      .map((key) => `env.${key}`),
  ];
  if (!keys.length) return undefined;
  return `Your Claude Code settings set ${keys.join(", ")}, so Claude Code tabs use that credential instead of this app's sign-in.`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The project folder holding a session's transcript. Symlinked folders are never scanned.
async function findSession(projects: string, sessionId: string) {
  const entries = await readdir(projects, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = await lstat(
      join(projects, entry.name, `${sessionId}.jsonl`),
    ).catch(() => null);
    if (file?.isFile()) return entry.name;
  }
  return undefined;
}

/**
 * Before a resume, copies a tab's session from the host's Claude Code folder into the app home
 * when the app does not have it yet (KTD10). Returns whether a copy was made.
 */
export async function migrateSession(
  host: HostPaths,
  home: string,
  sessionId: string,
) {
  if (!UUID.test(sessionId)) return false;
  const target = resolve(home, "projects");
  if (await findSession(target, sessionId)) return false;
  const source = resolve(hostClaudeDir(host), "projects");
  if (source === target) return false;
  // `sessionId` is a UUID and `name` a directory entry, so neither can leave its folder.
  const name = await findSession(source, sessionId);
  if (!name) return false;
  const from = join(source, name);
  const to = join(target, name);
  await mkdir(to, { recursive: true, mode: 0o700 });
  const kind = (path: string) => lstat(path).catch(() => null);
  // Symlinked entries in the host session folder are never followed.
  const filter = async (path: string) => !(await kind(path))?.isSymbolicLink();
  // Copies an entry through a temporary name, so a half-done copy is never found as a session.
  const copy = async (entry: string, recursive: boolean) => {
    const staging = join(to, `.${entry}.${randomUUID()}.tmp`);
    await cp(join(from, entry), staging, { recursive, filter });
    try {
      await rename(staging, join(to, entry));
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  };
  if ((await kind(join(from, sessionId)))?.isDirectory())
    // A folder already there from an earlier, unfinished copy is kept.
    await copy(sessionId, true).catch((error: unknown) => {
      const { code } = error as NodeJS.ErrnoException;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
    });
  // The transcript lands last.
  await copy(`${sessionId}.jsonl`, false);
  return true;
}
