import { homedir } from "node:os";
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
import type { InitializeParams } from "./generated/InitializeParams";
import type { AskForApproval } from "./generated/v2/AskForApproval";
import type { SandboxPolicy } from "./generated/v2/SandboxPolicy";
import type { SandboxMode } from "./generated/v2/SandboxMode";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams";
import type { TurnStartParams } from "./generated/v2/TurnStartParams";
import type { ToolRequestUserInputResponse } from "./generated/v2/ToolRequestUserInputResponse";
import type { PermissionsRequestApprovalResponse } from "./generated/v2/PermissionsRequestApprovalResponse";
import type { McpServerElicitationRequestResponse } from "./generated/v2/McpServerElicitationRequestResponse";
import {
  JsonRpcTransport,
  RpcError,
  object,
  string,
  type RpcNotification,
  type RpcRequest,
} from "./transport";

const IDLE_MS = 10 * 60_000;
const LOGIN_HOSTS = ["auth.openai.com", "chatgpt.com"];
const ARGS = ["app-server", "--listen", "stdio://"];

/** Test fixtures replace how the executable is launched. */
export type Launcher = (
  executable: string,
  args: string[],
  env: Record<string, string>,
) => { executable: string; args: string[]; env: Record<string, string> };

const direct: Launcher = (executable, args, env) => ({ executable, args, env });

const ask = {
  approvalPolicy: "on-request" as AskForApproval,
  approvalsReviewer: "user" as const,
};
/** KTD7: the tab's access mode replaces the host's Codex sandbox and approval settings. */
export function accessSettings(loadout: Loadout, cwd: string) {
  if (loadout.planMode || loadout.access === "ask")
    return {
      ...ask,
      sandbox: "read-only" as SandboxMode,
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: false,
      } as SandboxPolicy,
    };
  return {
    approvalPolicy: "never" as AskForApproval,
    sandbox: "workspace-write" as SandboxMode,
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    } as SandboxPolicy,
  };
}

export const loginUrlAllowed = (value: string) => {
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

const versionOf = (userAgent: string) =>
  /\/(\d+\.\d+\.\d+)/.exec(userAgent)?.[1] ?? null;
const clip = (text: string, limit = 400) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/** One shared app-server process per executable (KTD5). */
class CodexProcess {
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
          // Native plan mode and user questions exist only behind the experimental API (KTD6).
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

interface PendingRequest {
  rpc: RpcRequest;
  // Elicitation answers are converted back to the requested schema's types.
  fields?: Record<string, string>;
}

class CodexSession implements HarnessSession {
  sessionId: string | undefined;
  private process: CodexProcess;
  private queue?: EventQueue<HarnessEvent>;
  private turnId = "";
  private pending = new Map<string, PendingRequest>();
  private failure?: HarnessError;
  private changes = new Map<string, string>();
  private closed = false;
  // A new thread's ID is reported on the first turn so the tab can resume it later.
  private announced: boolean;

  constructor(
    private adapter: CodexAdapter,
    private context: LaunchContext,
    private request: OpenRequest,
    process: CodexProcess,
    threadId: string,
  ) {
    this.process = process;
    this.sessionId = threadId;
    this.announced = Boolean(request.sessionId);
    process.sessions.add(this);
  }

  get active() {
    return Boolean(this.queue && !this.queue.ended);
  }

  private async ensureProcess() {
    if (this.process.alive) return;
    // After a crash the next turn restarts the process and resumes the thread by ID.
    this.process.sessions.delete(this);
    this.process = await this.adapter.process(this.context);
    this.process.sessions.add(this);
    this.process.release();
    await this.adapter.resume(this.process, this.sessionId!, this.request);
  }

  async *send(prompt: string, loadout: Loadout): AsyncIterable<HarnessEvent> {
    await this.ensureProcess();
    const queue = new EventQueue<HarnessEvent>();
    this.queue = queue;
    if (!this.announced) {
      this.announced = true;
      queue.push({ type: "session", sessionId: this.sessionId! });
    }
    this.turnId = "";
    this.failure = undefined;
    this.changes.clear();
    const access = accessSettings(loadout, this.request.cwd);
    const params: TurnStartParams = {
      threadId: this.sessionId!,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      approvalPolicy: access.approvalPolicy,
      ...("approvalsReviewer" in access
        ? { approvalsReviewer: access.approvalsReviewer }
        : {}),
      sandboxPolicy: access.sandboxPolicy,
      // collaborationMode wins over top-level model and effort, so the loadout goes in settings.
      // A null developer_instructions keeps the harness's own mode instructions (KTD6).
      collaborationMode: {
        mode: loadout.planMode ? "plan" : "default",
        settings: {
          model: loadout.model,
          reasoning_effort: (loadout.effort ?? null) as never,
          developer_instructions: null,
        },
      },
    };
    this.process.transport
      .request("turn/start", params as unknown as Record<string, unknown>)
      .then((response) => {
        this.turnId ||= string(object(object(response).turn).id);
      })
      .catch((error) =>
        queue.fail(
          new HarnessError(
            "failed",
            error instanceof Error ? error.message : "Codex rejected the turn.",
          ),
        ),
      );
    try {
      yield* queue;
    } finally {
      this.queue = undefined;
      this.pending.clear();
    }
  }

  notification({ method, params }: RpcNotification) {
    const queue = this.queue;
    if (!queue) return;
    const item = object(params.item);
    const itemId = string(params.itemId) || string(item.id);
    switch (method) {
      case "turn/started":
        this.turnId = string(object(params.turn).id);
        return;
      case "item/agentMessage/delta":
        return queue.push({
          type: "text",
          item: itemId,
          kind: "assistant",
          delta: string(params.delta),
        });
      case "item/reasoning/summaryTextDelta":
        return queue.push({
          type: "text",
          item: itemId,
          kind: "reasoning",
          delta: string(params.delta),
        });
      case "item/plan/delta":
        return queue.push({
          type: "text",
          item: itemId,
          kind: "plan",
          delta: string(params.delta),
        });
      case "turn/plan/updated": {
        const steps = Array.isArray(params.plan) ? params.plan : [];
        const text = [
          string(params.explanation),
          ...steps.map((value) => {
            const step = object(value);
            const mark =
              step.status === "completed"
                ? "x"
                : step.status === "inProgress"
                  ? "~"
                  : " ";
            return `- [${mark}] ${string(step.step)}`;
          }),
        ]
          .filter(Boolean)
          .join("\n");
        return queue.push({
          type: "message",
          item: `steps-${string(params.turnId)}`,
          kind: "plan",
          text,
        });
      }
      case "item/started":
      case "item/completed":
        return this.item(method === "item/completed", item);
      case "error": {
        if (params.willRetry === true) return;
        this.failure = this.adapter.error(object(params.error));
        return;
      }
      case "turn/completed": {
        const turn = object(params.turn);
        if (turn.status === "failed")
          queue.fail(this.failure ?? this.adapter.error(object(turn.error)));
        else queue.end();
        return;
      }
    }
  }

  private item(completed: boolean, item: Record<string, unknown>) {
    const queue = this.queue!;
    const id = string(item.id);
    switch (item.type) {
      case "agentMessage":
        if (completed)
          queue.push({
            type: "message",
            item: id,
            kind: "assistant",
            text: string(item.text),
          });
        return;
      case "plan":
        if (completed)
          queue.push({
            type: "message",
            item: id,
            kind: "plan",
            text: string(item.text),
          });
        return;
      case "reasoning": {
        const summary = (Array.isArray(item.summary) ? item.summary : [])
          .map(string)
          .join("\n\n");
        if (completed && summary)
          queue.push({
            type: "message",
            item: id,
            kind: "reasoning",
            text: summary,
          });
        return;
      }
      case "commandExecution": {
        const exit =
          typeof item.exitCode === "number" ? ` (exit ${item.exitCode})` : "";
        return queue.push({
          type: "tool",
          item: id,
          summary: `${string(item.command)}${completed ? exit : ""}`,
          ...(completed ? { detail: string(item.aggregatedOutput) } : {}),
        });
      }
      case "fileChange": {
        const changes = (Array.isArray(item.changes) ? item.changes : []).map(
          object,
        );
        const paths = changes.map((change) => string(change.path));
        const diff = changes
          .map((change) => `${string(change.path)}\n${string(change.diff)}`)
          .join("\n\n");
        this.changes.set(id, diff);
        return queue.push({
          type: "tool",
          item: id,
          summary: `${completed ? "Edited" : "Editing"} ${paths.length === 1 ? paths[0] : `${paths.length} files`}`,
          detail: diff,
        });
      }
      case "mcpToolCall":
        return queue.push({
          type: "tool",
          item: id,
          summary: `MCP ${string(item.server)}.${string(item.tool)}`,
          ...(completed
            ? {
                detail: clip(
                  JSON.stringify(item.result ?? item.error ?? null),
                  20_000,
                ),
              }
            : {}),
        });
      case "webSearch":
        return queue.push({
          type: "tool",
          item: id,
          summary: `Web search: ${string(item.query)}`,
        });
      case "dynamicToolCall":
        return queue.push({
          type: "tool",
          item: id,
          summary: `Tool ${string(item.tool)}`,
        });
    }
  }

  serverRequest(rpc: RpcRequest) {
    const queue = this.queue;
    const params = rpc.params;
    const key = String(rpc.id);
    if (!queue) {
      this.process.transport.reject(
        rpc.id,
        "No turn is running for this request.",
      );
      return;
    }
    switch (rpc.method) {
      case "item/commandExecution/requestApproval":
        this.pending.set(key, { rpc });
        return queue.push({
          type: "approval",
          request: key,
          summary: `Run command: ${clip(string(params.command) || "a command")}`,
          detail: [
            string(params.reason),
            string(params.cwd) && `in ${string(params.cwd)}`,
          ]
            .filter(Boolean)
            .join("\n"),
        });
      case "item/fileChange/requestApproval":
        this.pending.set(key, { rpc });
        return queue.push({
          type: "approval",
          request: key,
          summary: "Apply file changes",
          detail: [
            string(params.reason),
            this.changes.get(string(params.itemId)) ?? "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        });
      case "item/permissions/requestApproval": {
        this.pending.set(key, { rpc });
        const permissions = object(params.permissions);
        const kinds = [
          permissions.network && "network access",
          permissions.fileSystem && "file system access",
        ]
          .filter(Boolean)
          .join(" and ");
        return queue.push({
          type: "approval",
          request: key,
          summary: `Grant ${kinds || "additional permissions"} for this turn`,
          detail: string(params.reason),
        });
      }
      case "item/tool/requestUserInput": {
        const questions = (
          Array.isArray(params.questions) ? params.questions : []
        ).map((value): HarnessQuestion => {
          const question = object(value);
          return {
            id: string(question.id),
            header: string(question.header),
            question: string(question.question) || string(question.header),
            options: (Array.isArray(question.options)
              ? question.options
              : []
            ).map((option) => ({
              label: string(object(option).label),
              description: string(object(option).description),
            })),
            multiSelect: false,
            allowOther:
              question.isOther === true || !Array.isArray(question.options),
            secret: question.isSecret === true,
          };
        });
        this.pending.set(key, { rpc });
        return queue.push({ type: "question", request: key, questions });
      }
      case "mcpServer/elicitation/request": {
        const mapped = elicitationQuestions(params);
        if (!mapped) {
          this.process.transport.respond(rpc.id, {
            action: "decline",
            content: null,
            _meta: null,
          } satisfies McpServerElicitationRequestResponse);
          return queue.push({
            type: "notice",
            notice: "unsupported_request",
            summary: `Declined a request from the ${string(params.serverName) || "MCP"} server that this app cannot show.`,
          });
        }
        this.pending.set(key, { rpc, fields: mapped.fields });
        return queue.push({
          type: "question",
          request: key,
          questions: mapped.questions,
        });
      }
      default:
        this.process.transport.reject(
          rpc.id,
          "This app does not support that request.",
        );
        return queue.push({
          type: "notice",
          notice: "unsupported_request",
          summary: `Codex asked for an unsupported operation (${rpc.method}); it was declined.`,
        });
    }
  }

  private take(request: string) {
    const pending = this.pending.get(request);
    if (!pending) throw new Error("That request is no longer pending.");
    this.pending.delete(request);
    return pending;
  }

  respond(request: string, decision: "accept" | "decline") {
    const { rpc } = this.take(request);
    const transport = this.process.transport;
    if (rpc.method === "item/permissions/requestApproval") {
      const requested = object(rpc.params.permissions);
      transport.respond(rpc.id, {
        permissions:
          decision === "accept"
            ? Object.fromEntries(
                Object.entries(requested).filter(([, value]) => value !== null),
              )
            : {},
        scope: "turn",
      } satisfies PermissionsRequestApprovalResponse);
    } else transport.respond(rpc.id, { decision });
  }

  answer(request: string, answers: Record<string, string[]>) {
    const { rpc, fields } = this.take(request);
    if (rpc.method === "mcpServer/elicitation/request")
      this.process.transport.respond(rpc.id, {
        action: "accept",
        content: elicitationContent(answers, fields ?? {}),
        _meta: null,
      } satisfies McpServerElicitationRequestResponse);
    else
      this.process.transport.respond(rpc.id, {
        answers: Object.fromEntries(
          Object.entries(answers).map(([id, values]) => [
            id,
            { answers: values },
          ]),
        ),
      } satisfies ToolRequestUserInputResponse);
  }

  async stop() {
    const transport = this.process.transport;
    // Stop answers every pending request first (KTD7), then interrupts the turn.
    for (const { rpc } of this.pending.values()) {
      if (rpc.method === "item/tool/requestUserInput")
        transport.respond(rpc.id, {
          answers: {},
        } satisfies ToolRequestUserInputResponse);
      else if (rpc.method === "item/permissions/requestApproval")
        transport.respond(rpc.id, {
          permissions: {},
          scope: "turn",
        } satisfies PermissionsRequestApprovalResponse);
      else if (rpc.method === "mcpServer/elicitation/request")
        transport.respond(rpc.id, {
          action: "cancel",
          content: null,
          _meta: null,
        } satisfies McpServerElicitationRequestResponse);
      else transport.respond(rpc.id, { decision: "cancel" });
    }
    this.pending.clear();
    if (!this.turnId || !this.active) return;
    await transport.request(
      "turn/interrupt",
      { threadId: this.sessionId, turnId: this.turnId },
      8_000,
    );
  }

  crashed(message: string) {
    this.pending.clear();
    this.queue?.fail(
      new HarnessError(
        "crashed",
        `Codex stopped during this turn. ${message} The next message restarts it.`,
      ),
    );
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.active) void this.stop().catch(() => {});
    this.process.sessions.delete(this);
    this.process.touch();
  }
}

// Maps a flat MCP form of string, number, boolean, and enum fields onto question cards.
function elicitationQuestions(params: Record<string, unknown>) {
  if (params.mode !== "form") return null;
  const schema = object(params.requestedSchema);
  const properties = Object.entries(object(schema.properties));
  if (!properties.length || properties.length > 10) return null;
  const fields: Record<string, string> = {};
  const questions: HarnessQuestion[] = [];
  for (const [id, value] of properties) {
    const property = object(value);
    const options = Array.isArray(property.enum)
      ? property.enum.map((option, index) => ({
          label:
            string(
              Array.isArray(property.enumNames)
                ? property.enumNames[index]
                : "",
            ) || String(option),
          description: "",
        }))
      : property.type === "boolean"
        ? [
            { label: "true", description: "Yes" },
            { label: "false", description: "No" },
          ]
        : [];
    if (
      !["string", "number", "integer", "boolean"].includes(
        string(property.type),
      )
    )
      return null;
    fields[id] = string(property.type);
    questions.push({
      id,
      header: string(property.title) || id,
      question:
        string(property.description) ||
        string(property.title) ||
        string(params.message) ||
        id,
      options,
      multiSelect: false,
      allowOther: !options.length,
      secret: false,
    });
  }
  return { questions, fields };
}

function elicitationContent(
  answers: Record<string, string[]>,
  fields: Record<string, string>,
) {
  return Object.fromEntries(
    Object.entries(answers).map(([id, [value = ""]]) => [
      id,
      fields[id] === "boolean"
        ? value === "true"
        : ["number", "integer"].includes(fields[id])
          ? Number(value)
          : value,
    ]),
  );
}

export class CodexAdapter implements HarnessAdapter {
  readonly id = "codex" as const;
  readonly signIn = "in_app" as const;
  readonly reportsAgents = true;
  closed = false;
  readonly idleMs: number;
  private processes = new Map<string, CodexProcess>();
  private listeners: (() => void)[] = [];
  private resetsAt: number | null = null;

  constructor(private options: { launcher?: Launcher; idleMs?: number } = {}) {
    this.idleMs = options.idleMs ?? IDLE_MS;
  }

  private get launcher() {
    return this.options.launcher ?? direct;
  }

  /** The shared process for an executable, started on first use. */
  async process(context: LaunchContext): Promise<CodexProcess> {
    if (this.closed)
      throw new HarnessError("failed", "The app is shutting down.");
    let process = this.processes.get(context.executable);
    if (!process || !process.alive) {
      process = new CodexProcess(context, this.launcher, this);
      this.processes.set(context.executable, process);
      const current = process;
      process.transport.on("request", (rpc: RpcRequest) => {
        const threadId = string(rpc.params.threadId);
        const session = [...current.sessions].find(
          (item) => item.sessionId === threadId,
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
      for (const listener of this.listeners) listener();
      return;
    }
    if (message.method === "account/rateLimits/updated") {
      this.readResets(message.params);
      return;
    }
    const threadId = string(message.params.threadId);
    if (!threadId) return;
    for (const process of this.processes.values())
      for (const session of process.sessions)
        if (session.sessionId === threadId) session.notification(message);
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

  async startSignIn(context: LaunchContext): Promise<string | null> {
    const process = await this.process(context);
    try {
      const account = object(
        object(
          await process.transport.request("account/read", {
            refreshToken: false,
          }),
        ).account,
      );
      if (account.type === "chatgpt") return null;
      const result = object(
        await process.transport.request("account/login/start", {
          type: "chatgpt",
        }),
      );
      const url = string(result.authUrl);
      if (!loginUrlAllowed(url))
        throw new Error("Codex returned an unsupported sign-in URL.");
      return url;
    } finally {
      process.release();
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
    const session = new CodexSession(this, request, request, process, threadId);
    process.release();
    return session;
  }

  onChange(listener: () => void) {
    this.listeners.push(listener);
  }

  close() {
    this.closed = true;
    for (const process of [...this.processes.values()]) process.close();
    this.processes.clear();
  }
}
