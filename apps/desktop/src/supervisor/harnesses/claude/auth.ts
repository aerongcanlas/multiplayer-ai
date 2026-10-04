import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface AuthStatus {
  loggedIn: boolean;
  email?: string;
  subscription?: string;
  version: string | null;
}

/**
 * Reads the Claude Code login in the app's own CLAUDE_CONFIG_DIR with `claude auth status --json`.
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

/** A running `claude auth login`: `done` settles when it exits; `cancel` ends it. */
export interface LoginProcess {
  done: Promise<void>;
  cancel(): void;
}

/**
 * Runs the unmodified program's own `auth login --claudeai` (KTD2). Claude Code opens Anthropic's
 * page in the browser itself and stores the result in its own keychain item for the app's
 * folder; the app sees no token. Stdin stays open and unused: the printed fallback URL leads to
 * a paste-the-code flow the app does not offer.
 */
export function startLogin(
  executable: string,
  env: Record<string, string>,
): LoginProcess {
  const child = spawn(executable, ["auth", "login", "--claudeai"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let tail = "";
  const keep = (data: Buffer) => {
    tail = (tail + data.toString("utf8")).slice(-2_000);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  let cancelled = false;
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && !cancelled) resolve();
      else
        reject(
          new Error(
            cancelled
              ? "Sign-in cancelled."
              : tail.trim() || `Claude Code sign-in exited with code ${code}.`,
          ),
        );
    });
  });
  return {
    done,
    cancel() {
      cancelled = true;
      child.stdin.end();
      if (child.exitCode === null) child.kill();
    },
  };
}

/** Runs Claude Code's own `auth logout` against the app's folder. */
export async function logout(executable: string, env: Record<string, string>) {
  await exec(executable, ["auth", "logout"], {
    env,
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 256 * 1024,
  });
}
