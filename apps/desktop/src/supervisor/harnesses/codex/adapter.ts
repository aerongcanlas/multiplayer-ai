import { homedir, tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  ContextSuggestionDraft,
  CONTEXT_AGENT_INSTRUCTIONS,
} from "@multiplayer-ai/domain/context-suggestions";
import {
  HarnessError,
  type HarnessAdapter,
  type HarnessSession,
  type Inspection,
  type LaunchContext,
  type OpenRequest,
  type SignInStart,
  type SuggestionRequest,
} from "../contract";
import { slashCommands } from "../commands";
import { clip, object, string } from "../json";
import { accessSettings } from "./access";
import { EventQueue } from "../queue";
import type { TurnStartParams } from "./generated/v2/TurnStartParams";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams";
import { ARGS, CodexProcess, versionOf, type Launcher } from "./process";
import { CodexSession } from "./session";
import { listSkills } from "./skills";
import {
  JsonRpcTransport,
  RpcError,
  type RpcNotification,
  type RpcRequest,
} from "./transport";
import { assertHome } from "../accounts";
import { CODEX_ACCOUNT } from "./account";

const IDLE_MS = 10 * 60_000;
const LOGIN_HOSTS = ["auth.openai.com", "chatgpt.com"];
const direct: Launcher = (executable, args, env) => ({ executable, args, env });

const loginUrlAllowed = (value: string) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      LOGIN_HOSTS.includes(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
};

export class CodexAdapter implements HarnessAdapter {
  readonly id = "codex" as const;
  readonly signIn = "in_app" as const;
  readonly account = CODEX_ACCOUNT;
  readonly reportsAgents = true;
  closed = false;
  readonly idleMs: number;
  private processes = new Map<string, CodexProcess>();
  private listeners: (() => void)[] = [];
  private resetsAt: number | null = null;
  // The pending ChatGPT sign-in, which holds its process open until it settles.
  private login?: {
    loginId: string;
    process: CodexProcess;
    settle: (error?: Error) => void;
  };

  constructor(private options: { launcher?: Launcher; idleMs?: number } = {}) {
    this.idleMs = options.idleMs ?? IDLE_MS;
  }

  private get launcher() {
    return this.options.launcher ?? direct;
  }

  /**
   * The shared process for an executable and home, started on first use. A process started for
   * another home is never reused (KTD7).
   */
  async process(context: LaunchContext): Promise<CodexProcess> {
    if (this.closed)
      throw new HarnessError("failed", "The app is shutting down.");
    assertHome(context, "CODEX_HOME");
    const key = `${context.executable}\n${context.home}`;
    let process = this.processes.get(key);
    if (!process || !process.alive) {
      process = new CodexProcess(context, this.launcher, this);
      this.processes.set(key, process);
      const current = process;
      process.transport.on("request", (rpc: RpcRequest) => {
        const threadId = string(rpc.params.threadId);
        const session = [...current.sessions].find((item) =>
          item.owns(threadId),
        );
        if (session) session.serverRequest(rpc);
        else
          current.transport.reject(
            rpc.id,
            "This app does not support that request.",
          );
      });
    }
    // Callers release this hold when their work ends.
    process.busy++;
    try {
      await process.ready;
    } catch (error) {
      process.busy--;
      process.close();
      throw new HarnessError(
        "unavailable",
        `Codex could not start. ${error instanceof Error ? error.message : ""}`.trim(),
      );
    }
    return process;
  }

  forget(process: CodexProcess) {
    for (const [key, value] of this.processes)
      if (value === process) this.processes.delete(key);
  }

  exited(process: CodexProcess, message: string) {
    this.forget(process);
    for (const session of process.sessions) session.crashed(message);
  }

  notification(message: RpcNotification) {
    if (
      message.method === "account/login/completed" ||
      message.method === "account/updated"
    ) {
      const login = this.login;
      if (
        message.method === "account/login/completed" &&
        login &&
        string(message.params.loginId) === login.loginId
      )
        login.settle(
          message.params.success === true
            ? undefined
            : new Error(
                string(message.params.error) || "Codex sign-in did not finish.",
              ),
        );
      for (const listener of this.listeners) listener();
      return;
    }
    if (message.method === "account/rateLimits/updated") {
      this.readResets(message.params);
      return;
    }
    // A spawned thread names its parent in a thread object, not a top-level thread ID.
    if (message.method === "thread/started") {
      const thread = object(message.params.thread);
      const parent = string(thread.parentThreadId);
      if (!parent) return;
      for (const session of this.sessionsOwning(parent))
        session.register(string(thread.id), parent, {
          name: string(thread.agentNickname),
          role: string(thread.agentRole),
        });
      return;
    }
    const threadId = string(message.params.threadId);
    if (!threadId) return;
    for (const session of this.sessionsOwning(threadId))
      session.notification(message);
  }

  private sessionsOwning(threadId: string) {
    return [...this.processes.values()].flatMap((process) =>
      [...process.sessions].filter((session) => session.owns(threadId)),
    );
  }

  private readResets(params: Record<string, unknown>) {
    const buckets = Object.values(object(params.rateLimitsByLimitId));
    if (params.rateLimits) buckets.push(params.rateLimits);
    const resets: number[] = [];
    for (const bucket of buckets.map(object))
      for (const key of ["primary", "secondary"]) {
        const window = object(bucket[key]);
        if (
          typeof window.resetsAt === "number" &&
          Number(window.usedPercent) >= 100
        )
          resets.push(window.resetsAt);
      }
    if (resets.length) this.resetsAt = Math.max(...resets);
  }

  private limits(params: Record<string, unknown>): Inspection["limits"] {
    const buckets = Object.values(object(params.rateLimitsByLimitId));
    if (!buckets.length && params.rateLimits) buckets.push(params.rateLimits);
    const limits: Inspection["limits"] = [];
    for (const bucket of buckets.map(object))
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
    this.readResets(params);
    return limits;
  }

  /** Maps a Codex turn error onto a harness failure kind. */
  error(error: Record<string, unknown>): HarnessError {
    const info = error.codexErrorInfo;
    const message = clip(string(error.message) || "Codex failed this turn.");
    if (info === "usageLimitExceeded" || info === "rateLimitExceeded")
      return new HarnessError("usage_limit", message, this.resetsAt);
    if (info === "unauthorized") return new HarnessError("signed_out", message);
    return new HarnessError("failed", message);
  }

  async handshake(context: LaunchContext) {
    assertHome(context, "CODEX_HOME");
    const launch = this.launcher(context.executable, ARGS, context.env);
    const transport = new JsonRpcTransport({
      ...launch,
      cwd: homedir(),
      name: "Codex",
    });
    transport.start();
    try {
      const result = object(
        await transport.request(
          "initialize",
          {
            clientInfo: {
              name: "multiplayer_ai_desktop",
              title: "Multiplayer AI",
              version: "0.1.0",
            },
          },
          10_000,
        ),
      );
      return { version: versionOf(string(result.userAgent)) };
    } finally {
      transport.close();
    }
  }

  async inspect(context: LaunchContext): Promise<Inspection> {
    const process = await this.process(context);
    try {
      const response = object(
        await process.transport.request("account/read", {
          refreshToken: false,
        }),
      );
      const account = object(response.account);
      if (account.type !== "chatgpt")
        return {
          auth: {
            state: "signed_out",
            message:
              "Sign in with ChatGPT to use Codex with your subscription.",
          },
          models: [],
          limits: [],
        };
      const models: Inspection["models"] = [];
      let cursor: string | null = null;
      do {
        const page = object(
          await process.transport.request("model/list", {
            limit: 100,
            includeHidden: false,
            cursor,
          }),
        );
        for (const value of Array.isArray(page.data) ? page.data : []) {
          const model = object(value);
          const id = string(model.model) || string(model.id);
          if (!id) continue;
          models.push({
            id,
            name: string(model.displayName) || id,
            efforts: (Array.isArray(model.supportedReasoningEfforts)
              ? model.supportedReasoningEfforts
              : []
            )
              .map((effort) => string(object(effort).reasoningEffort))
              .filter(Boolean),
            defaultEffort: string(model.defaultReasoningEffort) || null,
            isDefault: model.isDefault === true,
          });
        }
        cursor = string(page.nextCursor) || null;
        if (models.length > 500)
          throw new Error("Codex returned an oversized model catalog.");
      } while (cursor);
      let limits: Inspection["limits"] = [];
      try {
        limits = this.limits(
          object(await process.transport.request("account/rateLimits/read")),
        );
      } catch {
        limits = [];
      }
      return {
        auth: {
          state: "signed_in",
          account: string(account.email) || "ChatGPT account",
          ...(string(account.planType)
            ? { plan: string(account.planType) }
            : {}),
        },
        models,
        limits,
      };
    } finally {
      process.release();
    }
  }

  async commands(request: LaunchContext & { cwd: string }) {
    const process = await this.process(request);
    try {
      return slashCommands(await listSkills(process.transport, request.cwd));
    } finally {
      process.release();
    }
  }

  async startSignIn(context: LaunchContext): Promise<SignInStart> {
    const process = await this.process(context);
    let held = false;
    try {
      const account = object(
        object(
          await process.transport.request("account/read", {
            refreshToken: false,
          }),
        ).account,
      );
      if (account.type === "chatgpt") return { state: "signed_in" };
      const result = object(
        await process.transport.request("account/login/start", {
          type: "chatgpt",
        }),
      );
      const url = string(result.authUrl);
      if (!loginUrlAllowed(url))
        throw new Error("Codex returned an unsupported sign-in URL.");
      const loginId = string(result.loginId);
      const done = new Promise<void>((resolve, reject) => {
        const login = {
          loginId,
          process,
          settle: (error?: Error) => {
            if (this.login !== login) return;
            this.login = undefined;
            process.release();
            if (error) reject(error);
            else resolve();
          },
        };
        this.login?.settle(new Error("A newer sign-in started."));
        this.login = login;
      });
      held = true;
      return { state: "pending", url, done };
    } finally {
      if (!held) process.release();
    }
  }

  async cancelSignIn() {
    const login = this.login;
    if (!login) return;
    login.settle(new Error("Sign-in cancelled."));
    await login.process.transport
      .request("account/login/cancel", { loginId: login.loginId })
      .catch(() => {
        /* The login already ended. */
      });
  }

  /** Signs the app's Codex home out, then closes its process so no session keeps the login. */
  async signOut(context: LaunchContext) {
    await this.cancelSignIn();
    const process = await this.process(context);
    try {
      await process.transport.request("account/logout");
    } finally {
      process.release();
      process.close();
    }
  }

  async resume(process: CodexProcess, threadId: string, request: OpenRequest) {
    const access = accessSettings(request.loadout, request.cwd);
    try {
      await process.transport.request("thread/resume", {
        threadId,
        cwd: request.cwd,
        approvalPolicy: access.approvalPolicy,
        sandbox: access.sandbox,
        excludeTurns: true,
      } satisfies ThreadResumeParams);
    } catch (error) {
      if (error instanceof RpcError)
        throw new HarnessError(
          "resume_failed",
          `Codex could not resume this tab's thread: ${error.message}`,
        );
      throw error;
    }
  }

  async open(request: OpenRequest): Promise<HarnessSession> {
    const process = await this.process(request);
    let threadId = request.sessionId;
    try {
      if (threadId) await this.resume(process, threadId, request);
      else {
        const access = accessSettings(request.loadout, request.cwd);
        const response = object(
          await process.transport.request("thread/start", {
            cwd: request.cwd,
            model: request.loadout.model || null,
            approvalPolicy: access.approvalPolicy,
            ...("approvalsReviewer" in access
              ? { approvalsReviewer: access.approvalsReviewer }
              : {}),
            sandbox: access.sandbox,
            serviceName: "multiplayer_ai_desktop",
          } satisfies ThreadStartParams),
        );
        threadId = string(object(response.thread).id);
        if (!threadId)
          throw new HarnessError("failed", "Codex did not create a thread.");
      }
    } catch (error) {
      process.release();
      throw error instanceof HarnessError
        ? error
        : new HarnessError(
            "failed",
            error instanceof Error
              ? error.message
              : "Codex could not open the thread.",
          );
    }
    const session = new CodexSession(this, request, process, threadId);
    process.release();
    return session;
  }

  onChange(listener: () => void) {
    this.listeners.push(listener);
  }

  async suggest(request: SuggestionRequest): Promise<ContextSuggestionDraft> {
    const prompt = JSON.stringify({
      messages: request.messages,
      context: null,
    });
    if (prompt.length > 64_000)
      throw new Error("Select fewer messages to generate prompt suggestions.");
    const process = await this.process(request);
    let cwd: string | undefined;
    let threadId = "";
    let turnId = "";
    let completed = false;
    const queue = new EventQueue<string>();
    const notification = ({ method, params }: RpcNotification) => {
      if (!threadId || params.threadId !== threadId) return;
      if (method === "turn/started") turnId = string(object(params.turn).id);
      if (method === "item/completed") {
        const item = object(params.item);
        if (item.type === "agentMessage") queue.push(string(item.text));
      }
      if (method === "error" && params.willRetry !== true)
        queue.fail(this.error(object(params.error)));
      if (method === "turn/completed") {
        completed = true;
        const turn = object(params.turn);
        if (turn.status === "completed") queue.end();
        else queue.fail(this.error(object(turn.error)));
      }
    };
    const disconnected = (message: string) =>
      queue.fail(new HarnessError("crashed", message));
    process.transport.on("notification", notification);
    process.transport.on("exit", disconnected);
    const timer = setTimeout(
      () => queue.fail(new Error("Prompt generation timed out. Try again.")),
      60_000,
    );
    try {
      // A fresh empty directory keeps repository instructions out of this context-only turn.
      cwd = await mkdtemp(join(tmpdir(), "multiplayer-context-"));
      const response = object(
        await process.transport.request("thread/start", {
          cwd,
          model: request.model.id,
          ephemeral: true,
          sandbox: "read-only",
          approvalPolicy: "never",
          config: {
            "agents.enabled": false,
            "features.apps": false,
            "features.shell_tool": false,
            "features.unified_exec": false,
            "tools.view_image": false,
            web_search: "disabled",
            mcp_servers: {},
          },
          dynamicTools: [],
          selectedCapabilityRoots: [],
          environments: [],
          developerInstructions: CONTEXT_AGENT_INSTRUCTIONS,
          serviceName: "multiplayer_ai_desktop",
        } satisfies ThreadStartParams),
      );
      threadId = string(object(response.thread).id);
      if (!threadId) throw new Error("Codex did not create a context session.");
      const turn = object(
        await process.transport.request("turn/start", {
          threadId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
          effort: request.model.defaultEffort as TurnStartParams["effort"],
          outputSchema: z.toJSONSchema(
            ContextSuggestionDraft,
          ) as TurnStartParams["outputSchema"],
        } satisfies TurnStartParams),
      );
      turnId ||= string(object(turn.turn).id);
      let final = "";
      for await (const text of queue) final = text;
      try {
        return ContextSuggestionDraft.parse(JSON.parse(final));
      } catch {
        throw new Error(
          "The context agent returned invalid suggestions. Try again.",
        );
      }
    } finally {
      clearTimeout(timer);
      process.transport.off("notification", notification);
      process.transport.off("exit", disconnected);
      if (threadId) {
        if (!completed && turnId)
          await process.transport
            .request("turn/interrupt", { threadId, turnId }, 5_000)
            .catch(() => {});
        await process.transport
          .request("thread/unsubscribe", { threadId }, 5_000)
          .catch(() => {});
      }
      process.release();
      // Codex can retain a Windows directory handle after unsubscribe. Cleanup must
      // not replace a generated result or the original generation error.
      if (cwd)
        await rm(cwd, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        }).catch(() => {});
    }
  }

  close() {
    this.closed = true;
    for (const process of [...this.processes.values()]) process.close();
    this.processes.clear();
  }
}
