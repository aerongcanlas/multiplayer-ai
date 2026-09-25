import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

import { object, string } from "../json";

export type RpcRequest = {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
};
export type RpcNotification = {
  method: string;
  params: Record<string, unknown>;
};

const MAX_MESSAGE = 16 * 1024 * 1024;

/**
 * Newline-delimited JSON-RPC over a child process's stdio. Emits `notification`, `request`, and
 * `exit` (with a message) events. Raw stderr never enters app state because it can contain local
 * paths and authentication details.
 */
export class JsonRpcTransport extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private buffer = "";
  private ended = false;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private options: {
      executable: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
      name: string;
    },
  ) {
    super();
  }

  get alive() {
    return Boolean(this.child) && !this.ended;
  }

  start() {
    const child = spawn(this.options.executable, this.options.args, {
      cwd: this.options.cwd,
      windowsHide: true,
      stdio: "pipe",
      env: this.options.env,
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.resume();
    child.stdin.on("error", () => {
      /* A closed pipe surfaces through the exit handler. */
    });
    child.on("error", () =>
      this.fail(
        `${this.options.name} could not start. Check its program in Harness settings.`,
      ),
    );
    child.on("exit", () => this.fail(`${this.options.name} exited.`));
  }

  private consume(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_MESSAGE) {
      this.fail(`${this.options.name} sent an oversized protocol message.`);
      return;
    }
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = object(JSON.parse(line));
      } catch {
        this.fail(`${this.options.name} sent an invalid protocol message.`);
        return;
      }
      if (typeof message.method === "string") {
        const params = object(message.params);
        if (typeof message.id === "number" || typeof message.id === "string")
          this.emit("request", {
            id: message.id,
            method: message.method,
            params,
          } satisfies RpcRequest);
        else
          this.emit("notification", {
            method: message.method,
            params,
          } satisfies RpcNotification);
      } else if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error)
          pending.reject(
            new RpcError(
              string(object(message.error).message).slice(0, 400) ||
                `${this.options.name} rejected the request.`,
              Number(object(message.error).code) || 0,
            ),
          );
        else pending.resolve(message.result);
      }
    }
  }

  private write(message: unknown) {
    if (!this.child || this.ended) return false;
    this.child.stdin.write(JSON.stringify(message) + "\n");
    return true;
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    timeout = 30_000,
  ): Promise<unknown> {
    if (!this.child || this.ended)
      return Promise.reject(new Error(`${this.options.name} is not running.`));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`${this.options.name} did not answer ${method} in time.`),
        );
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>) {
    this.write({ method, params });
  }

  respond(id: string | number, result: unknown) {
    this.write({ id, result });
  }

  reject(id: string | number, message: string) {
    this.write({ id, error: { code: -32601, message } });
  }

  private fail(message: string) {
    if (this.ended) return;
    this.close();
    this.emit("exit", message);
  }

  close() {
    if (this.ended) return;
    this.ended = true;
    const child = this.child;
    this.buffer = "";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${this.options.name} stopped.`));
    }
    this.pending.clear();
    if (child) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 1_500);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    }
  }
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}
