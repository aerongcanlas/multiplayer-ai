import { homedir } from "node:os";
import type { HarnessQuestion, Loadout, PlanStep } from "../../../shared/tabs";
import {
  HarnessError,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessSession,
  type Inspection,
  type LaunchContext,
  type OpenRequest,
  type SessionEvent,
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
  // The sub-agent thread that asked; its requests outlive the lead's turn (KTD5).
  agent?: string;
}

/** A sub-agent thread spawned from the tab's thread or from another sub-agent (KTD11). */
interface SubAgent {
  parentKey?: string;
  turnId: string;
  running: boolean;
  // Its latest agent message, reported as the card's summary when it finishes.
  last: string;
}

const STEP_STATUS: Record<string, PlanStep["status"]> = {
  pending: "pending",
  inProgress: "active",
  completed: "done",
};
// Collab calls that send a finished sub-agent more work (KTD15).
const REENGAGE = new Set([
  "sendInput",
  "followupTask",
  "resumeAgent",
  "sendMessage",
]);
const AGENT_STATE: Record<string, "completed" | "failed" | "stopped"> = {
  completed: "completed",
  errored: "failed",
  interrupted: "stopped",
  shutdown: "stopped",
};

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
  private agents = new Map<string, SubAgent>();
  // A lead turn Codex started by itself (KTD14), and its events held until the owner's turn has
  // fully ended on the host.
  private harnessTurn = false;
  private backlog: SessionEvent[] = [];
  private flushing = false;

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

  /** Whether a thread's notifications and requests belong to this tab. */
  owns(threadId: string) {
    return threadId === this.sessionId || this.agents.has(threadId);
  }

  private listen(event: SessionEvent) {
    if (!this.closed) this.request.listener?.(event);
  }

  private harness(event: SessionEvent) {
    if (this.queue || this.flushing) this.backlog.push(event);
    else this.listen(event);
  }

  private flush() {
    if (!this.backlog.length || this.flushing) return;
    this.flushing = true;
    setImmediate(() => {
      this.flushing = false;
      for (const event of this.backlog.splice(0)) this.listen(event);
    });
  }

  /** Where a thread's events go: a sub-agent's card, the owner's turn, or a harness turn. */
  private out(threadId: string): ((event: HarnessEvent) => void) | undefined {
    if (threadId !== this.sessionId)
      return this.agents.has(threadId)
        ? (event) => this.listen({ ...event, agent: threadId } as HarnessEvent)
        : undefined;
    const queue = this.active ? this.queue! : undefined;
    if (queue) return (event) => queue.push(event);
    if (this.harnessTurn) return (event) => this.harness(event);
    return undefined;
  }

  /** Registers a sub-agent thread under the thread that spawned it (KTD11). */
  register(
    threadId: string,
    parent: string,
    details: { name?: string; role?: string } = {},
  ) {
    if (!threadId || threadId === this.sessionId) return;
    const known = this.agents.get(threadId);
    if (!known) {
      const parentKey = parent !== this.sessionId ? parent : undefined;
      this.agents.set(threadId, {
        ...(parentKey ? { parentKey } : {}),
        turnId: "",
        running: true,
        last: "",
      });
      this.listen({
        type: "agent",
        key: threadId,
        ...(parentKey ? { parentKey } : {}),
        status: "running",
      });
    }
    if (details.name || details.role)
      this.listen({
        type: "agent",
        key: threadId,
        ...(details.name ? { name: details.name } : {}),
        ...(details.role ? { agentType: details.role } : {}),
      });
  }

  private agentStatus(
    threadId: string,
    status: "running" | "completed" | "failed" | "stopped",
    summary?: string,
  ) {
    const agent = this.agents.get(threadId);
    if (!agent || agent.running === (status === "running")) return;
    agent.running = status === "running";
    this.listen({
      type: "agent",
      key: threadId,
      status,
      ...(summary ? { summary } : {}),
    });
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
      // Sub-agent requests stay answerable after the lead's turn (KTD5).
      for (const [key, pending] of this.pending)
        if (!pending.agent) this.pending.delete(key);
      this.flush();
    }
  }

  notification({ method, params }: RpcNotification) {
    const threadId = string(params.threadId);
    const lead = threadId === this.sessionId;
    const agent = this.agents.get(threadId);
    if (method === "turn/started") {
      const turnId = string(object(params.turn).id);
      if (agent) {
        agent.turnId = turnId;
        return this.agentStatus(threadId, "running");
      }
      if (this.active) this.turnId = turnId;
      else if (!this.harnessTurn) {
        // Codex started a lead turn by itself (KTD14).
        this.harnessTurn = true;
        this.turnId = turnId;
        this.harness({ type: "turn.started" });
      }
      return;
    }
    if (method === "turn/completed") {
      const turn = object(params.turn);
      if (agent)
        return this.agentStatus(
          threadId,
          turn.status === "failed"
            ? "failed"
            : turn.status === "interrupted"
              ? "stopped"
              : "completed",
          turn.status === "failed"
            ? string(object(turn.error).message) || agent.last
            : agent.last,
        );
      const failure =
        turn.status === "failed"
          ? (this.failure ?? this.adapter.error(object(turn.error)))
          : undefined;
      if (this.active) {
        if (failure) this.queue!.fail(failure);
        else this.queue!.end();
      } else if (this.harnessTurn) {
        this.harnessTurn = false;
        this.harness(
          failure
            ? { type: "turn.failed", error: failure }
            : { type: "turn.completed" },
        );
      }
      return;
    }
    if (method === "error") {
      if (!lead || params.willRetry === true) return;
      this.failure = this.adapter.error(object(params.error));
      return;
    }
    const item = object(params.item);
    if (method === "item/started" || method === "item/completed")
      this.agentItem(threadId, method === "item/completed", item);
    const emit = this.out(threadId);
    if (!emit) return;
    const itemId = string(params.itemId) || string(item.id);
    switch (method) {
      case "item/agentMessage/delta":
        return emit({
          type: "text",
          item: itemId,
          kind: "assistant",
          delta: string(params.delta),
        });
      case "item/reasoning/summaryTextDelta":
        return emit({
          type: "text",
          item: itemId,
          kind: "reasoning",
          delta: string(params.delta),
        });
      case "item/plan/delta":
        return emit({
          type: "text",
          item: itemId,
          kind: "plan",
          delta: string(params.delta),
        });
      case "turn/plan/updated": {
        const steps = (Array.isArray(params.plan) ? params.plan : []).map(
          object,
        );
        const text = [
          string(params.explanation),
          ...steps.map((step) => {
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
        emit({
          type: "message",
          item: `steps-${string(params.turnId)}`,
          kind: "plan",
          text,
        });
        // Only the lead's own plan becomes the tab's plan (KTD9).
        if (lead)
          emit({
            type: "steps",
            steps: steps.map((step) => ({
              text: string(step.step),
              status: STEP_STATUS[string(step.status)] ?? "pending",
            })),
            ...(string(params.explanation)
              ? { explanation: string(params.explanation) }
              : {}),
          });
        return;
      }
      case "item/started":
      case "item/completed":
        return this.item(method === "item/completed", item, emit);
    }
  }

  /** Collab calls and sub-agent activity drive cards whether or not a lead turn runs. */
  private agentItem(
    threadId: string,
    completed: boolean,
    item: Record<string, unknown>,
  ) {
    if (item.type === "collabAgentToolCall") {
      const receivers = (
        Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
      ).map(string);
      const sender = string(item.senderThreadId) || threadId;
      if (item.tool === "spawnAgent")
        for (const receiver of receivers) {
          this.register(receiver, sender);
          this.listen({
            type: "agent",
            key: receiver,
            ...(string(item.prompt)
              ? { description: clip(string(item.prompt), 2_000) }
              : {}),
            ...(string(item.model) ? { model: string(item.model) } : {}),
          });
        }
      if (REENGAGE.has(string(item.tool)) && !completed)
        for (const receiver of receivers) this.agentStatus(receiver, "running");
      if (completed)
        for (const [receiver, value] of Object.entries(
          object(item.agentsStates),
        )) {
          const state = object(value);
          const status = AGENT_STATE[string(state.status)];
          if (status)
            this.agentStatus(
              receiver,
              status,
              string(state.message) || this.agents.get(receiver)?.last,
            );
        }
      return;
    }
    if (item.type === "subAgentActivity") {
      const key = string(item.agentThreadId);
      const last = this.agents.get(key)?.last;
      if (item.kind === "started" || item.kind === "interacted")
        this.agentStatus(key, "running");
      else if (item.kind === "completed")
        this.agentStatus(key, "completed", last);
      else if (item.kind === "interrupted")
        this.agentStatus(key, "stopped", last);
      return;
    }
    const agent = this.agents.get(threadId);
    if (agent && completed && item.type === "agentMessage")
      agent.last = string(item.text);
  }

  private item(
    completed: boolean,
    item: Record<string, unknown>,
    emit: (event: HarnessEvent) => void,
  ) {
    const id = string(item.id);
    switch (item.type) {
      case "collabAgentToolCall": {
        const receivers = Array.isArray(item.receiverThreadIds)
          ? item.receiverThreadIds.length
          : 0;
        const label: Record<string, string> = {
          spawnAgent: "Spawn a sub-agent",
          sendInput: "Message a sub-agent",
          sendMessage: "Message a sub-agent",
          followupTask: "Follow up with a sub-agent",
          resumeAgent: "Resume a sub-agent",
          wait: "Wait for sub-agents",
          closeAgent: "Close a sub-agent",
          interruptAgent: "Interrupt a sub-agent",
          listAgents: "List sub-agents",
        };
        return emit({
          type: "tool",
          item: id,
          summary: `${label[string(item.tool)] ?? "Coordinate sub-agents"}${receivers > 1 ? ` (${receivers})` : ""}${string(item.prompt) ? `: ${clip(string(item.prompt), 200)}` : ""}`,
        });
      }
      case "agentMessage":
        if (completed)
          emit({
            type: "message",
            item: id,
            kind: "assistant",
            text: string(item.text),
          });
        return;
      case "plan":
        if (completed)
          emit({
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
          emit({
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
        return emit({
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
        return emit({
          type: "tool",
          item: id,
          summary: `${completed ? "Edited" : "Editing"} ${paths.length === 1 ? paths[0] : `${paths.length} files`}`,
          detail: diff,
        });
      }
      case "mcpToolCall":
        return emit({
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
        return emit({
          type: "tool",
          item: id,
          summary: `Web search: ${string(item.query)}`,
        });
      case "dynamicToolCall":
        return emit({
          type: "tool",
          item: id,
          summary: `Tool ${string(item.tool)}`,
        });
    }
  }

  serverRequest(rpc: RpcRequest) {
    const params = rpc.params;
    const key = String(rpc.id);
    const threadId = string(params.threadId);
    const agent = threadId !== this.sessionId ? threadId : undefined;
    // A sub-agent thread's requests reach the owner with or without a lead turn (KTD5).
    const emit = this.out(threadId);
    if (!emit) {
      this.process.transport.reject(
        rpc.id,
        "No turn is running for this request.",
      );
      return;
    }
    const hold = (fields?: Record<string, string>) =>
      this.pending.set(key, {
        rpc,
        ...(fields ? { fields } : {}),
        ...(agent ? { agent } : {}),
      });
    switch (rpc.method) {
      case "item/commandExecution/requestApproval":
        hold();
        return emit({
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
        hold();
        return emit({
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
        hold();
        const permissions = object(params.permissions);
        const kinds = [
          permissions.network && "network access",
          permissions.fileSystem && "file system access",
        ]
          .filter(Boolean)
          .join(" and ");
        return emit({
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
        hold();
        return emit({ type: "question", request: key, questions });
      }
      case "mcpServer/elicitation/request": {
        const mapped = elicitationQuestions(params);
        if (!mapped) {
          this.process.transport.respond(rpc.id, {
            action: "decline",
            content: null,
            _meta: null,
          } satisfies McpServerElicitationRequestResponse);
          return emit({
            type: "notice",
            notice: "unsupported_request",
            summary: `Declined a request from the ${string(params.serverName) || "MCP"} server that this app cannot show.`,
          });
        }
        hold(mapped.fields);
        return emit({
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
        return emit({
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
    // The lead's turn and each running sub-agent thread's turn are interrupted (KTD7).
    const turns: [string, string][] = [
      ...[...this.agents]
        .filter(([, agent]) => agent.running && agent.turnId)
        .map(([threadId, agent]): [string, string] => [threadId, agent.turnId]),
    ];
    if (this.turnId && (this.active || this.harnessTurn))
      turns.unshift([this.sessionId!, this.turnId]);
    await Promise.all(
      turns.map(([threadId, turnId]) =>
        transport.request("turn/interrupt", { threadId, turnId }, 8_000),
      ),
    );
  }

  crashed(message: string) {
    this.pending.clear();
    for (const agent of this.agents.values()) agent.running = false;
    const summary = `Codex stopped. ${message} The next message restarts it.`;
    if (this.active)
      return this.queue!.fail(
        new HarnessError(
          "crashed",
          `Codex stopped during this turn. ${message} The next message restarts it.`,
        ),
      );
    if (this.harnessTurn) {
      this.harnessTurn = false;
      return this.harness({
        type: "turn.failed",
        error: new HarnessError("crashed", summary),
      });
    }
    this.harness({ type: "crashed", message: summary });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (
      this.active ||
      this.harnessTurn ||
      [...this.agents.values()].some((agent) => agent.running)
    )
      void this.stop().catch(() => {});
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
      for (const listener of this.listeners) listener();
      return;
    }
    if (message.method === "account/rateLimits/updated") {
      this.readResets(message.params);
      return;
    }
    // A spawned thread names its parent in a thread object, not a top-level thread ID (KTD11).
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
