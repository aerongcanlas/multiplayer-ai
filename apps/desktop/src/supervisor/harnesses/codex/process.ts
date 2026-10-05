import { homedir } from "node:os";
import type { LaunchContext } from "../contract";
import { object, string } from "../json";
import type { CodexAdapter } from "./adapter";
import type { InitializeParams } from "./generated/InitializeParams";
import type { CodexSession } from "./session";
import { JsonRpcTransport, type RpcNotification } from "./transport";

export const ARGS = ["app-server", "--listen", "stdio://"];

/** Test fixtures replace how the executable is launched. */
export type Launcher = (
  executable: string,
  args: string[],
  env: Record<string, string>,
) => { executable: string; args: string[]; env: Record<string, string> };

export const versionOf = (userAgent: string) =>
  /\/(\d+\.\d+\.\d+)/.exec(userAgent)?.[1] ?? null;

/** One shared app-server process per executable and app home. */
export class CodexProcess {
  readonly transport: JsonRpcTransport;
  readonly ready: Promise<void>;
  readonly sessions = new Set<CodexSession>();
  version: string | null = null;
  // Holds for work outside a session (inspect, sign-in, opening a thread) keep it open.
  busy = 0;
  private idle?: ReturnType<typeof setTimeout>;

  constructor(
    context: LaunchContext,
    launcher: Launcher,
    private adapter: CodexAdapter,
  ) {
    const launch = launcher(context.executable, ARGS, context.env);
    const transport = new JsonRpcTransport({
      executable: launch.executable,
      args: launch.args,
      env: launch.env,
      cwd: homedir(),
      name: "Codex",
    });
    this.transport = transport;
    transport.start();
    transport.on("notification", (message: RpcNotification) =>
      this.adapter.notification(message),
    );
    transport.on("exit", (message: string) => {
      clearTimeout(this.idle);
      this.adapter.exited(this, message);
    });
    this.ready = (async () => {
      const result = object(
        await transport.request("initialize", {
          clientInfo: {
            name: "multiplayer_ai_desktop",
            title: "Multiplayer AI",
            version: "0.1.0",
          },
          // Native plan mode and user questions exist only behind the experimental API.
          capabilities: { experimentalApi: true, requestAttestation: false },
        } satisfies InitializeParams as Record<string, unknown>),
      );
      this.version = versionOf(string(result.userAgent));
      transport.notify("initialized", {});
    })();
    this.ready.catch(() => transport.close());
  }

  get alive() {
    return this.transport.alive;
  }

  /** Closes the process once no Codex tab has used it for ten minutes. */
  touch() {
    clearTimeout(this.idle);
    if (this.sessions.size || this.busy || !this.alive || this.adapter.closed)
      return;
    this.idle = setTimeout(() => {
      if (!this.sessions.size && !this.busy) this.close();
    }, this.adapter.idleMs);
    this.idle.unref?.();
  }

  /** Ends a hold taken by `CodexAdapter.process`. */
  release() {
    this.busy = Math.max(0, this.busy - 1);
    this.touch();
  }

  close() {
    clearTimeout(this.idle);
    this.transport.close();
    this.adapter.forget(this);
  }
}
