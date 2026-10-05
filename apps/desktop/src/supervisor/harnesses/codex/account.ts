import { join } from "node:path";
import { hostHome, type AccountSpec, type HostPaths } from "../accounts";

/** The host's own Codex folder, where its setup lives. */
const hostCodexHome = (host: HostPaths) =>
  host.CODEX_HOME || join(hostHome(host), ".codex");

/**
 * Codex's app home: the host's config, instructions, skills, prompts, rules, and plugins are
 * linked in; the login (auth.json or a keyring entry keyed by the home) and session history stay
 * the app's own.
 */
export const CODEX_ACCOUNT: AccountSpec = {
  variable: "CODEX_HOME",
  source: hostCodexHome,
  links: ["config.toml", "AGENTS.md", "skills", "prompts", "rules", "plugins"],
};
