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
import { join, relative, resolve, sep } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { hostHome, type AccountSpec, type HostPaths } from "../accounts";
import { object } from "../json";

/** The host's own Claude Code folder, where its setup lives. */
export const hostClaudeDir = (host: HostPaths) =>
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
export const hostClaudeJson = (host: HostPaths) =>
  host.CLAUDE_CONFIG_DIR
    ? join(host.CLAUDE_CONFIG_DIR, ".claude.json")
    : join(hostHome(host), ".claude.json");

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
  cwd?: string,
): Promise<Record<string, McpServerConfig>> {
  let config: Record<string, unknown>;
  try {
    config = object(JSON.parse(await readFile(hostClaudeJson(host), "utf8")));
  } catch {
    return {};
  }
  const local = cwd
    ? servers(object(object(config.projects)[resolve(cwd)]).mcpServers)
    : {};
  return { ...servers(config.mcpServers), ...local };
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
  let settings: Record<string, unknown>;
  try {
    settings = object(
      JSON.parse(
        await readFile(join(hostClaudeDir(host), "settings.json"), "utf8"),
      ),
    );
  } catch {
    return undefined;
  }
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

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return Boolean(rel) && !rel.startsWith("..") && !rel.includes(`..${sep}`);
};

async function findSession(projects: string, sessionId: string) {
  const names = await readdir(projects).catch(() => [] as string[]);
  for (const name of names) {
    const folder = join(projects, name);
    const info = await lstat(folder).catch(() => null);
    if (!info?.isDirectory()) continue;
    const file = await lstat(join(folder, `${sessionId}.jsonl`)).catch(
      () => null,
    );
    if (file?.isFile()) return name;
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
  if (resolve(source) === target) return false;
  const name = await findSession(source, sessionId);
  if (!name) return false;
  const from = join(source, name);
  const to = join(target, name);
  if (!inside(source, from) || !inside(target, to)) return false;
  await mkdir(to, { recursive: true, mode: 0o700 });
  // Symlinked entries in the host session folder are never followed.
  const filter = async (path: string) =>
    !(await lstat(path).catch(() => null))?.isSymbolicLink();
  const folder = join(from, sessionId);
  const folderInfo = await lstat(folder).catch(() => null);
  if (folderInfo?.isDirectory()) {
    const staging = join(to, `.${sessionId}.${randomUUID()}.tmp`);
    await cp(folder, staging, { recursive: true, filter });
    await rename(staging, join(to, sessionId)).catch(async (error: unknown) => {
      await rm(staging, { recursive: true, force: true });
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" &&
        (error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
      )
        throw error;
    });
  }
  const file = `${sessionId}.jsonl`;
  const staging = join(to, `.${file}.${randomUUID()}.tmp`);
  await cp(join(from, file), staging, { filter });
  // The transcript lands last, so a half-done copy is never found as a session.
  await rename(staging, join(to, file));
  return true;
}
