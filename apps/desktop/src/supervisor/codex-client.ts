import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { z } from "zod";
import type { ProviderState } from "../shared/provider";

const exec = promisify(execFile);
export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
export type RpcRequest = {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
};
export type RpcNotification = {
  method: string;
  params: Record<string, unknown>;
};

// No provider credentials from the application's launching shell enter Codex.
export function localEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|COMSPEC|PATHEXT)$/i.test(
        key,
      ),
    ),
  );
}

export async function findCodex(): Promise<string> {
  const candidates =
    process.platform === "win32"
      ? [
          join(
            process.env.LOCALAPPDATA ?? "",
            "Programs",
            "OpenAI",
            "Codex",
            "bin",
            "codex.exe",
          ),
          ...String(process.env.PATH ?? "")
            .split(";")
            .filter(Boolean)
            .map((dir) => join(dir, "codex.exe")),
        ]
      : String(process.env.PATH ?? "")
          .split(":")
          .filter(Boolean)
          .map((dir) => join(dir, "codex"));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* Try next installed runtime. */
    }
  }
  throw new Error(
    "Install Codex CLI, then refresh the ChatGPT connection. A native Codex executable must be available.",
  );
}

export class CodexClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private buffer = "";
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private starting?: Promise<void>;
  private loginId?: string;
  private state: ProviderState = {
    status: "disconnected",
    message: "Connect your ChatGPT account to run agents.",
    models: [],
    limits: [],
  };
  constructor(
    private options: {
      executable?: string;
      args?: string[];
      cwd: string;
      env?: NodeJS.ProcessEnv;
    },
  ) {
    super();
  }
  snapshot(): ProviderState {
    return structuredClone(this.state);
  }
  private update(value: Partial<ProviderState>) {
    this.state = { ...this.state, ...value };
    this.emit("state", this.snapshot());
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = this.launch().catch((error) => {
      this.close();
      this.update({
        status: "unavailable",
        account: undefined,
        models: [],
        message:
          error instanceof Error ? error.message : "Codex failed to start.",
      });
      throw error;
    });
    return this.starting;
  }
  private async launch() {
    this.update({
      status: "connecting",
      message: "Connecting to local Codex...",
    });
    const executable = this.options.executable ?? (await findCodex());
    if (!this.options.args) {
      const result = await exec(executable, ["--version"], {
        windowsHide: true,
        env: localEnvironment(),
        timeout: 10_000,
      });
      const version = /codex-cli (\d+\.\d+\.\d+)/.exec(result.stdout)?.[1];
      if (version !== "0.147.0")
        throw new Error(
          `Codex ${version ?? "unknown"} is installed. This desktop currently supports Codex 0.147.0.`,
        );
      this.update({ version });
    }
    const child = spawn(
      executable,
      this.options.args ?? [
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        'forced_login_method="chatgpt"',
        "-c",
        "agents.enabled=false",
        "-c",
          "features.apps=false",
          "-c",
          "mcp_servers={}",
      ],
      {
        cwd: this.options.cwd,
        windowsHide: true,
        stdio: "pipe",
        env: this.options.env ?? localEnvironment(),
      },
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    // Raw stderr can contain paths and authentication details; it never enters app state.
    child.stderr.resume();
    child.on("error", () =>
      this.failed("Codex could not start. Check its installation."),
    );
    child.on("exit", () => {
      if (this.child === child)
        this.failed(
          "Codex disconnected. Refresh the connection before starting another run.",
        );
    });
    await this.request("initialize", {
      clientInfo: {
        name: "multiplayer_ai_desktop",
        title: "Multiplayer AI",
        version: "0.1.0",
      },
    });
    this.notify("initialized", {});
  }
  private consume(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 16 * 1024 * 1024) {
      this.failed("Codex sent an oversized protocol message.");
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
        this.failed("Codex sent an invalid protocol message.");
        return;
      }
      if (typeof message.method === "string") {
        const params = object(message.params);
        if (typeof message.id === "number" || typeof message.id === "string") {
          this.emit("request", {
            id: message.id,
            method: message.method,
            params,
          } satisfies RpcRequest);
        } else {
          this.emit("notification", {
            method: message.method,
            params,
          } satisfies RpcNotification);
          if (message.method === "account/login/completed") {
            this.loginId = undefined;
            if (params.success === true) void this.refresh().catch(() => {});
            else
              this.update({
                status: "disconnected",
                message:
                  "ChatGPT sign-in did not complete. Try connecting again.",
              });
          }
          if (message.method === "account/rateLimits/updated")
            this.readLimits(params);
        }
      } else if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error)
          pending.reject(
            new Error(
              string(object(message.error).message).slice(0, 400) ||
                "Codex rejected the request.",
            ),
          );
        else pending.resolve(message.result);
      }
    }
  }
  request(
    method: string,
    params: Record<string, unknown> = {},
    timeout = 30_000,
  ): Promise<unknown> {
    if (!this.child || this.child.stdin.destroyed)
      return Promise.reject(new Error("Codex is not connected."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`Codex ${method} timed out. Refresh before retrying.`),
        );
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(
        JSON.stringify({ id, method, params }) + "\n",
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(new Error("Codex transport closed."));
          }
        },
      );
    });
  }
  notify(method: string, params: Record<string, unknown>) {
    this.child?.stdin.write(JSON.stringify({ method, params }) + "\n");
  }
  respond(id: string | number, result: unknown) {
    this.child?.stdin.write(JSON.stringify({ id, result }) + "\n");
  }
  reject(id: string | number) {
    this.child?.stdin.write(
      JSON.stringify({
        id,
        error: {
          code: -32601,
          message: "This client does not support that operation.",
        },
      }) + "\n",
    );
  }
  async refresh() {
    await this.start();
    const account = object(
      object(await this.request("account/read", { refreshToken: false }))
        .account,
    );
    if (account.type !== "chatgpt") {
      this.update({
        status: "disconnected",
        account: undefined,
        models: [],
        limits: [],
        message:
          "Connect ChatGPT to use your subscription. API-key execution is not enabled.",
      });
      return;
    }
    const models: ProviderState["models"] = [];
    let cursor: string | null = null;
    do {
      const response = object(
        await this.request("model/list", {
          limit: 100,
          includeHidden: false,
          cursor,
        }),
      );
      for (const value of Array.isArray(response.data) ? response.data : []) {
        const item = object(value);
        const id = string(item.model) || string(item.id);
        if (id)
          models.push({
            id,
            name: string(item.displayName) || id,
            defaultEffort: string(item.defaultReasoningEffort) || "medium",
            isDefault: item.isDefault === true,
            efforts: (Array.isArray(item.supportedReasoningEfforts)
              ? item.supportedReasoningEfforts
              : []
            )
              .map((effort) => string(object(effort).reasoningEffort))
              .filter(Boolean),
          });
      }
      cursor = string(response.nextCursor) || null;
      if (models.length > 500)
        throw new Error("Codex returned an oversized model catalog.");
    } while (cursor);
    this.update({
      status: "connected",
      account: {
        label: string(account.email) || "ChatGPT account",
        plan: string(account.planType) || "ChatGPT",
      },
      models,
      message: "Uses your local Codex sign-in and ChatGPT allowance.",
    });
    try {
      this.readLimits(object(await this.request("account/rateLimits/read")));
    } catch {
      this.update({ limits: [] });
    }
  }
  private readLimits(params: Record<string, unknown>) {
    const buckets = Object.values(object(params.rateLimitsByLimitId));
    if (!buckets.length && params.rateLimits) buckets.push(params.rateLimits);
    const limits: ProviderState["limits"] = [];
    for (const value of buckets) {
      const bucket = object(value);
      for (const key of ["primary", "secondary"]) {
        const window = object(bucket[key]);
        if (typeof window.usedPercent === "number")
          limits.push({
            name: `${string(bucket.limitName) || string(bucket.limitId) || "Codex"} · ${window.windowDurationMins ?? "?"} min`,
            usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
            resetsAt:
              typeof window.resetsAt === "number" ? window.resetsAt : null,
          });
      }
    }
    this.update({ limits });
  }
  async connect(): Promise<string | null> {
    await this.refresh();
    if (this.state.status === "connected") return null;
    if (this.loginId) throw new Error("A ChatGPT sign-in is already pending.");
    const result = object(
      await this.request("account/login/start", { type: "chatgpt" }),
    );
    const url = z.url().parse(result.authUrl);
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      !["auth.openai.com", "chatgpt.com"].includes(parsed.hostname) ||
      parsed.username ||
      parsed.password
    )
      throw new Error("Codex returned an unsupported sign-in URL.");
    this.loginId = string(result.loginId);
    this.update({
      status: "signing_in",
      message: "Complete ChatGPT sign-in in your browser.",
    });
    return url;
  }
  async cancelLogin() {
    if (this.loginId)
      await this.request("account/login/cancel", { loginId: this.loginId });
    this.loginId = undefined;
    this.update({ status: "disconnected", message: "Sign-in cancelled." });
  }
  async disconnect() {
    await this.start();
    await this.cancelLogin();
    await this.request("account/logout");
    this.update({
      status: "disconnected",
      account: undefined,
      models: [],
      limits: [],
      message: "Signed out of local Codex.",
    });
  }
  private failed(message: string) {
    this.close();
    this.update({
      status: "unavailable",
      account: undefined,
      models: [],
      limits: [],
      message,
    });
    this.emit("disconnected", message);
  }
  close() {
    const child = this.child;
    this.child = undefined;
    this.starting = undefined;
    this.buffer = "";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex connection closed."));
    }
    this.pending.clear();
    if (child) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 1500);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    }
  }
}
