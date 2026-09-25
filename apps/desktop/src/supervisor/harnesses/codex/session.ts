import type { HarnessQuestion, Loadout, PlanStep } from "../../../shared/tabs";
import {
  HarnessError,
  type HarnessEvent,
  type HarnessSession,
  type OpenRequest,
  type SessionEvent,
} from "../contract";
import { clip, object, string } from "../json";
import { EventQueue } from "../queue";
import { SessionRelay } from "../relay";
import { accessSettings } from "./access";
import type { CodexAdapter } from "./adapter";
import { elicitationContent, elicitationQuestions } from "./elicitation";
import type { McpServerElicitationRequestResponse } from "./generated/v2/McpServerElicitationRequestResponse";
import type { PermissionsRequestApprovalResponse } from "./generated/v2/PermissionsRequestApprovalResponse";
import type { ToolRequestUserInputResponse } from "./generated/v2/ToolRequestUserInputResponse";
import type { TurnStartParams } from "./generated/v2/TurnStartParams";
import type { CodexProcess } from "./process";
import type { RpcNotification, RpcRequest } from "./transport";

interface PendingRequest {
  rpc: RpcRequest;
  // Elicitation answers are converted back to the requested schema's types.
  fields?: Record<string, string>;
  // The sub-agent thread that asked; its requests outlive the lead's turn.
  agent?: string;
}

/** A sub-agent thread spawned from the tab's thread or from another sub-agent. */
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
// Collab calls that send a finished sub-agent more work.
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

export class CodexSession implements HarnessSession {
  sessionId: string | undefined;
  private process: CodexProcess;
  private queue?: EventQueue<HarnessEvent>;
  private turnId = "";
  private pending = new Map<string, PendingRequest>();
  private failure?: HarnessError;
  private changes = new Map<string, string>();
  // A new thread's ID is reported on the first turn so the tab can resume it later.
  private announced: boolean;
  private agents = new Map<string, SubAgent>();
  // A lead turn Codex started by itself.
  private harnessTurn = false;
  private relay: SessionRelay;

  constructor(
    private adapter: CodexAdapter,
    private request: OpenRequest,
    process: CodexProcess,
    threadId: string,
  ) {
    this.process = process;
    this.sessionId = threadId;
    this.announced = Boolean(request.sessionId);
    this.relay = new SessionRelay(request.listener, () => Boolean(this.queue));
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
    this.relay.send(event);
  }

  private harness(event: SessionEvent) {
    this.relay.hold(event);
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

  /** Registers a sub-agent thread under the thread that spawned it. */
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
    this.process = await this.adapter.process(this.request);
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
      // A null developer_instructions keeps the harness's own mode instructions.
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
      // Sub-agent requests stay answerable after the lead's turn.
      for (const [key, pending] of this.pending)
        if (!pending.agent) this.pending.delete(key);
      this.relay.flush();
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
        // Codex started a lead turn by itself.
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
        // Only the lead's own plan becomes the tab's plan.
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
    // A sub-agent thread's requests reach the owner with or without a lead turn.
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
    // Stop answers every pending request first, then interrupts the turn.
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
    // The lead's turn and each running sub-agent thread's turn are interrupted.
    const turns = [...this.agents]
      .filter(([, agent]) => agent.running && agent.turnId)
      .map(([threadId, agent]) => [threadId, agent.turnId]);
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
    if (this.relay.closed) return;
    this.relay.closed = true;
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
