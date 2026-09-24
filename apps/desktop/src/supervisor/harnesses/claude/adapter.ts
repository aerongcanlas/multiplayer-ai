import { homedir } from "node:os";
import type {
  AccountInfo,
  CanUseTool,
  ModelInfo,
  Options,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { HarnessQuestion, Loadout } from "../../../shared/tabs";
import {
  HarnessError,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessSession,
  type Inspection,
  type LaunchContext,
  type OpenRequest,
} from "../contract";
import { EventQueue } from "../queue";
import { readAuthStatus, type AuthStatus } from "./auth";

const IDLE_MS = 10 * 60_000;

/** The part of the SDK's Query this adapter uses. */
export interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  accountInfo(): Promise<AccountInfo>;
  supportedModels(): Promise<ModelInfo[]>;
  interrupt(): Promise<unknown>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>;
  close(): void;
}
export type StartQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ClaudeQuery;

// The SDK is ESM-only; it loads on first use so a missing or broken install only affects Claude
// Code tabs.
const sdkQuery: StartQuery = (params) => {
  const loaded = import("@anthropic-ai/claude-agent-sdk");
  let query: ClaudeQuery | undefined;
  const ready = loaded.then(({ query: start }) => {
    query = start(params) as unknown as ClaudeQuery;
    return query;
  });
  const call =
    <K extends keyof ClaudeQuery>(name: K) =>
    async (...args: unknown[]) =>
      ((await ready)[name] as (...values: unknown[]) => unknown)(...args);
  return {
    accountInfo: call("accountInfo") as ClaudeQuery["accountInfo"],
    supportedModels: call("supportedModels") as ClaudeQuery["supportedModels"],
    interrupt: call("interrupt"),
    setPermissionMode: call(
      "setPermissionMode",
    ) as ClaudeQuery["setPermissionMode"],
    setModel: call("setModel") as ClaudeQuery["setModel"],
    applyFlagSettings: call(
      "applyFlagSettings",
    ) as ClaudeQuery["applyFlagSettings"],
    close: () => {
      if (query) query.close();
      else void ready.then((started) => started.close()).catch(() => {});
    },
    async *[Symbol.asyncIterator]() {
      yield* await ready;
    },
  };
};

export interface ClaudeOptions {
  /** Test fixtures replace the SDK query and the auth status check. */
  startQuery?: StartQuery;
  authStatus?: (context: LaunchContext) => Promise<AuthStatus>;
  idleMs?: number;
}

/** A push-driven prompt stream for one streaming-input query. */
class PromptChannel implements AsyncIterable<SDKUserMessage> {
  private queue = new EventQueue<SDKUserMessage>();
  push(text: string) {
    this.queue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
  }
  end() {
    this.queue.end();
  }
  [Symbol.asyncIterator]() {
    return this.queue[Symbol.asyncIterator]();
  }
}

export const permissionMode = (loadout: Loadout): PermissionMode =>
  loadout.planMode
    ? "plan"
    : loadout.access === "auto"
      ? "acceptEdits"
      : "default";

/** KTD8: the host's environment plus the flags every Claude Code launch needs. */
export function claudeEnvironment(
  context: LaunchContext,
): Record<string, string> {
  return {
    ...context.env,
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "multiplayer-ai/0.1.0",
  };
}

const clip = (text: string, limit = 400) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

export function toolSummary(name: string, input: Record<string, unknown>) {
  if (name === "Bash") return `Run command: ${clip(text(input.command))}`;
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name))
    return `${name === "Write" ? "Write" : "Edit"} ${text(input.file_path) || text(input.notebook_path)}`;
  if (name === "Read") return `Read ${text(input.file_path)}`;
  if (name === "WebFetch") return `Fetch ${text(input.url)}`;
  if (name === "WebSearch") return `Web search: ${text(input.query)}`;
  if (name === "Glob" || name === "Grep")
    return `${name} ${text(input.pattern)}`;
  if (name === "Skill")
    return `Run skill ${text(input.skill) || text(input.command)}`;
  return `Use ${name}`;
}

const blockText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((block) => text(record(block).text))
          .filter(Boolean)
          .join("\n")
      : "";

type Waiter = (result: PermissionResult) => void;
interface Pending {
  kind: "approval" | "plan" | "question";
  input: Record<string, unknown>;
  resolve: Waiter;
}

class ClaudeSession implements HarnessSession {
  sessionId: string | undefined;
  private query?: ClaudeQuery;
  private channel?: PromptChannel;
  private turn?: EventQueue<HarnessEvent>;
  private loadout: Loadout;
  private pending = new Map<string, Pending>();
  private tools = new Map<string, string>();
  private messageId = "";
  private idle?: ReturnType<typeof setTimeout>;
  private initialized = false;
  private resumeSession: string | undefined;
  private resetsAt: number | null = null;
  private closed = false;
  private counter = 0;
  private stderr = "";

  constructor(
    private adapter: ClaudeAdapter,
    private request: OpenRequest,
  ) {
    this.sessionId = request.sessionId;
    this.resumeSession = request.sessionId;
    this.loadout = request.loadout;
  }

  private start() {
    const channel = new PromptChannel();
    this.channel = channel;
    this.initialized = false;
    this.query = this.adapter.startQuery({
      prompt: channel,
      options: {
        pathToClaudeCodeExecutable: this.request.executable,
        cwd: this.request.cwd,
        env: claudeEnvironment(this.request),
        // SDK 0.3.280 sends an empty system prompt when this is omitted (KTD8).
        systemPrompt: { type: "preset", preset: "claude_code" },
        // The host's own skills, plugins, hooks, instructions, and MCP servers load (R28).
        settingSources: ["user", "project", "local"],
        permissionMode: permissionMode(this.loadout),
        ...(this.loadout.model ? { model: this.loadout.model } : {}),
        ...(this.loadout.effort
          ? { effort: this.loadout.effort as Options["effort"] }
          : {}),
        ...(this.resumeSession ? { resume: this.resumeSession } : {}),
        includePartialMessages: true,
        canUseTool: this.canUseTool,
        // Raw stderr never enters app state; a short tail is kept only to classify failures.
        stderr: (data) => {
          this.stderr = (this.stderr + data).slice(-2_000);
        },
      },
    });
    void this.pump(this.query);
  }

  private async pump(query: ClaudeQuery) {
    let failure: HarnessError;
    try {
      for await (const message of query) {
        if (this.query !== query) return;
        this.message(message);
      }
      failure = new HarnessError(
        "crashed",
        "Claude Code stopped during this turn.",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A resumed query that fails before it initializes could not load the session.
      failure =
        this.resumeSession && !this.initialized
          ? new HarnessError(
              "resume_failed",
              /No conversation found/i.test(`${message}\n${this.stderr}`)
                ? "Claude Code could not find this tab's session."
                : `Claude Code could not resume this tab's session. ${clip(message, 200)}`,
            )
          : new HarnessError(
              "crashed",
              `Claude Code stopped. ${clip(message, 200)}`,
            );
    }
    // A query released while idle ends quietly; only the current query fails the turn.
    if (this.query !== query) return;
    this.query = undefined;
    this.channel = undefined;
    this.denyAll("Claude Code stopped.");
    this.turn?.fail(failure);
  }

  private canUseTool: CanUseTool = (name, input, options) =>
    new Promise<PermissionResult>((resolve) => {
      const turn = this.turn;
      if (!turn)
        return resolve({ behavior: "deny", message: "No turn is running." });
      const request = `${options.toolUseID || "tool"}:${++this.counter}`;
      options.signal.addEventListener("abort", () => {
        if (this.pending.delete(request))
          resolve({ behavior: "deny", message: "Cancelled." });
      });
      if (name === "AskUserQuestion") {
        const questions = (
          Array.isArray(input.questions) ? input.questions : []
        ).map((value, index): HarnessQuestion => {
          const question = record(value);
          return {
            id: String(index),
            header: text(question.header),
            question:
              text(question.question) || text(question.header) || "Question",
            options: (Array.isArray(question.options)
              ? question.options
              : []
            ).map((option) => ({
              label: text(record(option).label),
              description: text(record(option).description),
            })),
            multiSelect: question.multiSelect === true,
            allowOther: true,
            secret: false,
          };
        });
        this.pending.set(request, { kind: "question", input, resolve });
        turn.push({ type: "question", request, questions });
        return;
      }
      if (name === "ExitPlanMode") {
        this.pending.set(request, { kind: "plan", input, resolve });
        turn.push({
          type: "approval",
          request,
          plan: true,
          summary:
            text(input.plan) || "Claude Code is ready to leave plan mode.",
        });
        return;
      }
      if (this.loadout.access === "auto" && !this.loadout.planMode)
        return resolve({ behavior: "allow", updatedInput: input });
      this.pending.set(request, { kind: "approval", input, resolve });
      turn.push({
        type: "approval",
        request,
        summary: toolSummary(name, input),
        detail: [
          options.description,
          clip(JSON.stringify(input, null, 2), 8_000),
        ]
          .filter(Boolean)
          .join("\n"),
      });
    });

  private message(message: SDKMessage) {
    const turn = this.turn;
    const value = record(message);
    if (value.type === "system" && value.subtype === "init") {
      this.initialized = true;
      const id = text(value.session_id);
      if (id && id !== this.sessionId) {
        this.sessionId = id;
        this.resumeSession = id;
        turn?.push({ type: "session", sessionId: id });
      }
      return;
    }
    if (value.type === "rate_limit_event") {
      const info = record(value.rate_limit_info);
      if (info.status === "rejected" && typeof info.resetsAt === "number")
        this.resetsAt = info.resetsAt;
      return;
    }
    if (!turn) return;
    if (value.type === "stream_event" && !value.parent_tool_use_id) {
      const event = record(value.event);
      if (event.type === "message_start")
        this.messageId = text(record(event.message).id);
      if (event.type === "content_block_delta") {
        const delta = record(event.delta);
        const item = `${this.messageId}:${event.index}`;
        if (delta.type === "text_delta")
          turn.push({
            type: "text",
            item,
            kind: "assistant",
            delta: text(delta.text),
          });
        if (delta.type === "thinking_delta")
          turn.push({
            type: "text",
            item,
            kind: "reasoning",
            delta: text(delta.thinking),
          });
      }
      return;
    }
    if (value.type === "assistant") {
      const body = record(value.message);
      const id = text(body.id);
      const error = text(value.error);
      if (
        error === "authentication_failed" ||
        error === "oauth_org_not_allowed"
      )
        this.failure = new HarnessError(
          "signed_out",
          "Claude Code is signed out.",
        );
      if (error === "rate_limit" || error === "billing_error")
        this.failure = new HarnessError(
          "usage_limit",
          "Claude Code reached its usage limit.",
          this.resetsAt,
        );
      (Array.isArray(body.content) ? body.content : []).forEach(
        (raw, index) => {
          const block = record(raw);
          if (block.type === "tool_use") {
            const summary = toolSummary(text(block.name), record(block.input));
            this.tools.set(text(block.id), summary);
            turn.push({ type: "tool", item: text(block.id), summary });
          } else if (!value.parent_tool_use_id && block.type === "text")
            turn.push({
              type: "message",
              item: `${id}:${index}`,
              kind: "assistant",
              text: text(block.text),
            });
          else if (!value.parent_tool_use_id && block.type === "thinking")
            turn.push({
              type: "message",
              item: `${id}:${index}`,
              kind: "reasoning",
              text: text(block.thinking),
            });
        },
      );
      return;
    }
    if (value.type === "user") {
      const content = record(value.message).content;
      for (const raw of Array.isArray(content) ? content : []) {
        const block = record(raw);
        if (block.type !== "tool_result") continue;
        const id = text(block.tool_use_id);
        turn.push({
          type: "tool",
          item: id,
          summary: `${this.tools.get(id) ?? "Tool"}${block.is_error ? " (failed)" : ""}`,
          detail: blockText(block.content),
        });
      }
      return;
    }
    if (value.type === "result") {
      const failure = this.failure;
      this.failure = undefined;
      if (value.subtype === "success" && !value.is_error) return turn.end();
      const detail =
        text(value.result) ||
        (Array.isArray(value.errors)
          ? value.errors.map(text).join("\n")
          : "") ||
        "Claude Code failed this turn.";
      if (failure) return turn.fail(failure);
      if (
        this.resumeSession &&
        !this.initialized &&
        /No conversation found/i.test(detail)
      )
        return turn.fail(
          new HarnessError(
            "resume_failed",
            "Claude Code could not find this tab's session.",
          ),
        );
      if (/usage limit|rate limit|limit reached/i.test(detail))
        return turn.fail(
          new HarnessError("usage_limit", clip(detail), this.resetsAt),
        );
      if (
        /not logged in|please run \/login|invalid api key|authentication/i.test(
          detail,
        )
      )
        return turn.fail(new HarnessError("signed_out", clip(detail)));
      turn.fail(new HarnessError("failed", clip(detail)));
    }
  }
  private failure?: HarnessError;

  private denyAll(message: string) {
    for (const pending of this.pending.values())
      pending.resolve({ behavior: "deny", message, interrupt: true });
    this.pending.clear();
  }

  async *send(prompt: string, loadout: Loadout): AsyncIterable<HarnessEvent> {
    clearTimeout(this.idle);
    this.loadout = loadout;
    const turn = new EventQueue<HarnessEvent>();
    this.turn = turn;
    this.failure = undefined;
    if (!this.query) this.start();
    else {
      // Streaming input keeps the loadout adjustable between turns (KTD8).
      await this.query.setModel(loadout.model || undefined);
      await this.query.applyFlagSettings({
        effortLevel: loadout.effort ?? null,
      });
      await this.query.setPermissionMode(permissionMode(loadout));
    }
    this.channel!.push(prompt);
    try {
      yield* turn;
      this.resumeSession = this.sessionId;
    } finally {
      this.turn = undefined;
      this.denyAll("The turn ended.");
      this.arm();
    }
  }

  /** Closes the query after ten idle minutes; the next send resumes the session. */
  private arm() {
    clearTimeout(this.idle);
    if (this.closed || this.adapter.closed) return;
    this.idle = setTimeout(() => this.release(), this.adapter.idleMs);
    this.idle.unref?.();
  }

  private release() {
    clearTimeout(this.idle);
    const query = this.query;
    this.query = undefined;
    this.channel?.end();
    this.channel = undefined;
    query?.close();
  }

  private take(request: string) {
    const pending = this.pending.get(request);
    if (!pending) throw new Error("That request is no longer pending.");
    this.pending.delete(request);
    return pending;
  }

  respond(request: string, decision: "accept" | "decline") {
    const pending = this.take(request);
    if (pending.kind === "plan") {
      if (decision === "accept") {
        // Continuing into execution switches to the tab's access mode.
        this.loadout = { ...this.loadout, planMode: false };
        void this.query
          ?.setPermissionMode(permissionMode(this.loadout))
          .finally(() =>
            pending.resolve({ behavior: "allow", updatedInput: pending.input }),
          );
      } else
        pending.resolve({
          behavior: "deny",
          message: "The host wants to keep planning.",
        });
      return;
    }
    pending.resolve(
      decision === "accept"
        ? { behavior: "allow", updatedInput: pending.input }
        : { behavior: "deny", message: "The host declined this request." },
    );
  }

  answer(request: string, answers: Record<string, string[]>) {
    const pending = this.take(request);
    const questions = Array.isArray(pending.input.questions)
      ? pending.input.questions
      : [];
    // The SDK's documented answer shape keys each answer by its question text.
    pending.resolve({
      behavior: "allow",
      updatedInput: {
        ...pending.input,
        answers: Object.fromEntries(
          questions.map((question, index) => [
            text(record(question).question),
            (answers[String(index)] ?? []).join(", "),
          ]),
        ),
      },
    });
  }

  async stop() {
    this.denyAll("The host stopped the turn.");
    if (this.turn && this.query) await this.query.interrupt();
  }

  close() {
    this.closed = true;
    this.denyAll("The tab was closed.");
    this.turn?.end();
    this.release();
    this.adapter.forget(this);
  }
}

/** Claude Code through the Claude Agent SDK, one streaming-input query per open tab (KTD8). */
export class ClaudeAdapter implements HarnessAdapter {
  readonly id = "claude" as const;
  // Anthropic's terms do not allow third-party products to offer claude.ai sign-in (R11).
  readonly signIn = "guidance" as const;
  closed = false;
  readonly idleMs: number;
  private sessions = new Set<ClaudeSession>();

  constructor(private options: ClaudeOptions = {}) {
    this.idleMs = options.idleMs ?? IDLE_MS;
  }

  startQuery: StartQuery = (params) =>
    (this.options.startQuery ?? sdkQuery)(params);

  private authStatus(context: LaunchContext) {
    return this.options.authStatus
      ? this.options.authStatus(context)
      : readAuthStatus(context.executable, claudeEnvironment(context));
  }

  async handshake(context: LaunchContext) {
    const status = await this.authStatus(context);
    if (!status.version) throw new Error("Its --version output did not parse.");
    return { version: status.version };
  }

  forget(session: ClaudeSession) {
    this.sessions.delete(session);
  }

  async inspect(context: LaunchContext): Promise<Inspection> {
    const status = await this.authStatus(context);
    if (!status.loggedIn)
      return {
        auth: {
          state: "signed_out",
          message:
            "Claude Code is not signed in on this computer. Sign in once with the Claude Code CLI (run claude, then /login), then refresh here.",
        },
        models: [],
        limits: [],
      };
    const channel = new PromptChannel();
    const query = this.startQuery({
      prompt: channel,
      options: {
        pathToClaudeCodeExecutable: context.executable,
        cwd: homedir(),
        env: claudeEnvironment(context),
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user"],
        stderr: () => {},
      },
    });
    try {
      const [models, account] = await Promise.all([
        query.supportedModels(),
        query.accountInfo().catch((): AccountInfo => ({})),
      ]);
      return {
        auth: {
          state: "signed_in",
          account: account.email ?? status.email ?? "Claude account",
          ...((account.subscriptionType ?? status.subscription)
            ? { plan: account.subscriptionType ?? status.subscription }
            : {}),
        },
        models: models.map((model, index) => ({
          id: model.value,
          name: model.displayName || model.value,
          efforts: model.supportedEffortLevels ?? [],
          defaultEffort: null,
          isDefault: model.value === "default" || index === 0,
        })),
        limits: [],
      };
    } finally {
      channel.end();
      query.close();
    }
  }

  async open(request: OpenRequest): Promise<HarnessSession> {
    if (this.closed)
      throw new HarnessError("failed", "The app is shutting down.");
    const session = new ClaudeSession(this, request);
    this.sessions.add(session);
    return session;
  }

  close() {
    this.closed = true;
    for (const session of this.sessions) session.close();
    this.sessions.clear();
  }
}
