import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface AuthStatus {
  loggedIn: boolean;
  email?: string;
  subscription?: string;
  version: string | null;
}

/**
 * Reads the machine's existing Claude Code login with `claude auth status --json`. The app never
 * starts a claude.ai sign-in of its own (R11).
 */
export async function readAuthStatus(
  executable: string,
  env: Record<string, string>,
): Promise<AuthStatus> {
  const options = {
    env,
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 256 * 1024,
  };
  const [status, version] = await Promise.all([
    exec(executable, ["auth", "status", "--json"], options).catch(
      // Signed-out installs can exit non-zero while still printing the JSON status.
      (error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }),
    ),
    exec(executable, ["--version"], options),
  ]);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(status.stdout) as Record<string, unknown>;
  } catch {
    throw new Error("Claude Code did not report its sign-in state.");
  }
  const text = (value: unknown) =>
    typeof value === "string" && value ? value : undefined;
  return {
    loggedIn: parsed.loggedIn === true,
    email: text(parsed.email),
    subscription: text(parsed.subscriptionType),
    version: /(\d+\.\d+\.\d+)/.exec(version.stdout)?.[1] ?? null,
  };
}
