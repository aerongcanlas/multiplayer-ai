import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { LaunchContext } from "../contract";
import { launchEnvironment } from "../environment";
import type { Launcher } from "../launcher";
import type { OpenCodeSession } from "./session";

// The embedded HTTP server stays on loopback; port 0 lets OpenCode pick a free one.
const ARGS = ["acp", "--hostname", "127.0.0.1", "--port", "0"];

/** The adapter side of a process: where its session events and permission requests go. */
export interface ProcessOwner {
  readonly idleMs: number;
  readonly closed: boolean;
  update(process: OpenCodeProcess, params: SessionNotification): void;
  permission(
    process: OpenCodeProcess,
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse>;
  exited(process: OpenCodeProcess, message: string): void;
  forget(process: OpenCodeProcess): void;
}

/** The variables every OpenCode launch carries on top of the host environment. */
function lockedEnvironment(
  env: Record<string, string>,
  config: Record<string, string>,
) {
  return {
    // Provider keys never reach OpenCode, whatever the caller passed.
    ...launchEnvironment(env),
    ...config,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  };
}

/** Runs a one-shot OpenCode CLI command and returns its output. */
export function runCommand(
  context: LaunchContext,
  launcher: Launcher,
  args: string[],
  options: { cwd: string; config: Record<string, string>; timeoutMs?: number },
): Promise<string> {
  const launch = launcher(
    context.executable,
    args,
    lockedEnvironment(context.env, options.config),
  );
  return new Promise((resolve, reject) =>
    execFile(
      launch.executable,
      launch.args,
      {
        cwd: options.cwd,
        env: launch.env,
        timeout: options.timeoutMs ?? 20_000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error)
          reject(
            new Error(
              `OpenCode could not run \`${args.join(" ")}\`${error.killed ? " in time" : ""}.`,
            ),
          );
        else resolve(stdout);
      },
    ),
  );
}

/**
 * One long-lived `opencode acp` process for an executable and injected config (KTD3). Its embedded
 * server is locked to loopback with a random password (KTD4), and the client advertises no file
 * system or terminal, so OpenCode runs its own tools.
 */
export class OpenCodeProcess {
  readonly connection: ClientSideConnection;
  readonly ready: Promise<void>;
  // Every session opened on this process, keyed by OpenCode's session ID.
  readonly sessions = new Map<string, OpenCodeSession>();
  version: string | null = null;
  // Holds for work in progress (inspect, open, a running turn) keep the process open.
  busy = 0;
  // A draining process takes no new turns and closes once its last one ends.
  draining = false;
  private child: ChildProcess;
  private idle?: ReturnType<typeof setTimeout>;
  private exit: Promise<never>;
  private fail!: (error: Error) => void;
  private ended = false;

  constructor(
    readonly key: string,
    context: LaunchContext,
    config: Record<string, string>,
    launcher: Launcher,
    private owner: ProcessOwner,
  ) {
    const launch = launcher(
      context.executable,
      ARGS,
      lockedEnvironment(context.env, {
        ...config,
        OPENCODE_SERVER_PASSWORD: randomBytes(32).toString("base64url"),
      }),
    );
    this.child = spawn(launch.executable, launch.args, {
      cwd: homedir(),
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    // OpenCode logs to stderr; it is drained and never stored.
    this.child.stderr?.resume();
    this.exit = new Promise<never>((_resolve, reject) => {
      this.fail = reject;
    });
    this.exit.catch(() => {});
    // An exit the app did not ask for is a crash for the sessions on this process.
    const ended = (message: string) => {
      if (this.ended) return;
      this.ended = true;
      clearTimeout(this.idle);
      this.fail(new Error(message));
      this.owner.exited(this, message);
    };
    this.child.once("error", (error) =>
      ended(`OpenCode could not start: ${error.message}`),
    );
    this.child.once("exit", (code, signal) =>
      ended(
        signal
          ? `OpenCode was stopped (${signal}).`
          : `OpenCode exited with code ${code}.`,
      ),
    );
    const stream = ndJsonStream(
      Writable.toWeb(this.child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>,
    );
    this.connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async (params) => this.owner.update(this, params),
        requestPermission: (params) => this.owner.permission(this, params),
      }),
      stream,
    );
    this.ready = this.call(async (connection) => {
      const result = await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: {
          name: "multiplayer_ai_desktop",
          title: "Multiplayer AI",
          version: "0.1.0",
        },
      });
      this.version = result.agentInfo?.version ?? null;
    }, 30_000);
    this.ready.catch(() => this.close());
  }

  get alive() {
    return !this.ended;
  }

  /** Runs a request, failing it when the process exits or the timeout passes. */
  call<T>(
    work: (connection: ClientSideConnection) => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    if (this.ended)
      return Promise.reject(new Error("OpenCode is no longer running."));
    const racers: Promise<T>[] = [work(this.connection), this.exit];
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs)
      racers.push(
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("OpenCode did not answer in time.")),
            timeoutMs,
          );
        }),
      );
    return Promise.race(racers).finally(() => clearTimeout(timer));
  }

  /** Whether the process ends within a short wait, as when a request failed because it exited. */
  ending(ms: number): Promise<boolean> {
    if (this.ended) return Promise.resolve(true);
    return Promise.race([
      this.exit.catch(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
    ]);
  }

  /** Takes a hold that keeps the process open; `release` ends it. */
  hold() {
    this.busy++;
    clearTimeout(this.idle);
  }

  release() {
    this.busy = Math.max(0, this.busy - 1);
    this.touch();
  }

  /** Closes the process once nothing has used it for the idle time, or at once when draining. */
  touch() {
    clearTimeout(this.idle);
    if (this.busy || !this.alive || this.owner.closed) return;
    if (this.draining) return this.close();
    if (this.sessions.size) return;
    this.idle = setTimeout(() => {
      if (!this.busy && !this.sessions.size) this.close();
    }, this.owner.idleMs);
    this.idle.unref?.();
  }

  /** Stops taking new turns; the process closes when its running work ends. */
  retire() {
    this.draining = true;
    this.touch();
  }

  /** Stops the process; its sessions resume on a new process at their next turn. */
  close() {
    clearTimeout(this.idle);
    this.owner.forget(this);
    if (this.ended) return;
    this.ended = true;
    this.fail(new Error("OpenCode was closed."));
    this.child.stdin?.end();
    this.child.kill();
  }
}
