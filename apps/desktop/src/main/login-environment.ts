import { execFile } from "node:child_process";

const MARKER = "__MULTIPLAYER_AI_ENV__";

/** Parses `env -0` output after the marker, ignoring anything shell startup files printed. */
export function parseEnvironment(output: string): Record<string, string> {
  const start = output.lastIndexOf(MARKER);
  if (start < 0) return {};
  const env: Record<string, string> = {};
  for (const line of output.slice(start + MARKER.length).split("\0")) {
    const index = line.indexOf("=");
    if (index > 0) env[line.slice(0, index)] = line.slice(index + 1);
  }
  return env;
}

/**
 * The host's login-shell environment (KTD15), so harnesses find the same PATH, SSH agent, and
 * tool configuration they have in a terminal. A Dock-launched app only has a minimal PATH. On
 * Windows, or when the shell fails or times out, the app's own environment is used.
 */
export function resolveLoginEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  timeout = 10_000,
): Promise<Record<string, string>> {
  const fallback = Object.fromEntries(
    Object.entries(base).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const shell = base.SHELL;
  if (platform === "win32" || !shell) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-ilc", `printf '%s' '${MARKER}'; command env -0`],
      { env: fallback, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        const env = error ? {} : parseEnvironment(stdout);
        resolve(env.PATH ? env : fallback);
      },
    );
  });
}
