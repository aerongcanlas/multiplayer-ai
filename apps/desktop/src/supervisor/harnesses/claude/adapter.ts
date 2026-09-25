import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
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
import { clip, object, string } from "../json";
import { EventQueue } from "../queue";
import { SessionRelay } from "../relay";
import { readAuthStatus, type AuthStatus } from "./auth";

const IDLE_MS = 10 * 60_000;

/** The part of the SDK's Query this adapter uses. */
export interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  accountInfo(): Promise<AccountInfo>;
  supportedModels(): Promise<ModelInfo[]>;
  interrupt(): Promise<unknown>;
  stopTask(taskId: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>;
  close(): void;
}
export type StartQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ClaudeQuery;

// The supervisor bundle loads the SDK's ESM entry at startup, so a broken package shows up
// before any tab opens. The SDK's own platform binary is not packaged; tabs use the managed CLI.
const sdkQuery: StartQuery = (params) =>
  query(params) as unknown as ClaudeQuery;

export interface ClaudeOptions {
  /** Test fixtures replace the SDK query and the auth status check. */
  startQuery?: StartQuery;
  authStatus?: (context: LaunchContext) => Promise<AuthStatus>;
  idleMs?: number;
}

/** A push-driven prompt stream for one streaming-input query. */
class PromptChannel implements AsyncIterable<SDKUserMessage> {
  private queue = new EventQueue<SDKUserMessage>();
  push(text: string, uuid: string) {
    this.queue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      uuid: uuid as SDKUserMessage["uuid"],
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

/** The host's environment plus the flags every Claude Code launch needs. */
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


export function toolSummary(name: string, input: Record<string, unknown>) {
  if (name === "Bash") return `Run command: ${clip(string(input.command))}`;
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name))
    return `${name === "Write" ? "Write" : "Edit"} ${string(input.file_path) || string(input.notebook_path)}`;
  if (name === "Read") return `Read ${string(input.file_path)}`;
  if (name === "WebFetch") return `Fetch ${string(input.url)}`;
  if (name === "WebSearch") return `Web search: ${string(input.query)}`;
  if (name === "Glob" || name === "Grep")
    return `${name} ${string(input.pattern)}`;
  if (name === "Skill")
    return `Run skill ${string(input.skill) || string(input.command)}`;
  return `Use ${name}`;
}

const blockText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((block) => string(object(block).text))
          .filter(Boolean)
          .join("\n")
      : "";

type Waiter = (result: PermissionResult) => void;
interface Pending {
  kind: "approval" | "plan" | "question";
  input: Record<string, unknown>;
  resolve: Waiter;
  // Set for a sub-agent's request, which outlives the lead's turn.
  agent?: string;
}

const STEP_STATUS: Record<string, PlanStep["status"]> = {
  pending: "pending",
  in_progress: "active",
  completed: "done",
};
const AGENT_END = {
  completed: "completed",
  failed: "failed",
  stopped: "stopped",
  killed: "stopped",
} as const;

/** Why a turn's result failed it, or undefined when it succeeded. */
function resultFailure(
  value: Record<string, unknown>,
  failure: HarnessError | undefined,
  resuming: boolean,
  resetsAt: number | null,
): HarnessError | undefined {
  if (value.subtype === "success" && !value.is_error) return undefined;
  const detail =
    string(value.result) ||
    (Array.isArray(value.errors) ? value.errors.map(string).join("\n") : "") ||
    "Claude Code failed this turn.";
  if (failure) return failure;
  if (resuming && /No conversation found/i.test(detail))
    return new HarnessError(
      "resume_failed",
      "Claude Code could not find this tab's session.",
    );
  if (/usage limit|rate limit|limit reached/i.test(detail))
    return new HarnessError("usage_limit", clip(detail), resetsAt);
  if (
    /not logged in|please run \/login|invalid api key|authentication/i.test(
      detail,
    )
  )
    return new HarnessError("signed_out", clip(detail));
  return new HarnessError("failed", clip(detail));
}

class ClaudeSession implements HarnessSession {
  sessionId: string | undefined;
  private query?: ClaudeQuery;
  private channel?: PromptChannel;
  private turn?: EventQueue<HarnessEvent>;
  // The owner's latest send, matched against each result.
  private owner = "";
  // A lead turn Claude Code started by itself, such as a reply to a finished background task.
  private harnessTurn = false;
  private relay: SessionRelay;
  // Sub-agent cards by task ID, and the task each spawning tool call started.
  private cards = new Map<string, { running: boolean }>();
  private spawned = new Map<string, string>();
  // The tool call each tool call ran inside, for nesting and sub-agent requests.
  private parents = new Map<string, string>();
  // Every non-ambient background task, sub-agent or not.
  private background = new Set<string>();
  // The lead's to-do list, from TodoWrite or TaskCreate and TaskUpdate.
  private steps: (PlanStep & { id: string })[] = [];
  private creating = new Map<string, string>();
  private loadout: Loadout;
  private pending = new Map<string, Pending>();
  private tools = new Map<string, string>();
  private messageId = "";
  private idle?: ReturnType<typeof setTimeout>;
  private initialized = false;
  private resetsAt: number | null = null;
  private failure?: HarnessError;
  private counter = 0;
  private stderr = "";

  constructor(
    private adapter: ClaudeAdapter,
    private request: OpenRequest,
  ) {
    this.sessionId = request.sessionId;
    this.loadout = request.loadout;
    this.relay = new SessionRelay(request.listener, () => Boolean(this.turn));
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
        // SDK 0.3.280 sends an empty system prompt when this is omitted.
        systemPrompt: { type: "preset", preset: "claude_code" },
        // The host's own skills, plugins, hooks, instructions, and MCP servers load.
        settingSources: ["user", "project", "local"],
        permissionMode: permissionMode(this.loadout),
        ...(this.loadout.model ? { model: this.loadout.model } : {}),
        ...(this.loadout.effort
          ? { effort: this.loadout.effort as Options["effort"] }
          : {}),
        ...(this.sessionId ? { resume: this.sessionId } : {}),
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
        this.sessionId && !this.initialized
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
    // The background set is per CLI process.
    this.background.clear();
    this.cards.clear();
    if (this.turn && !this.turn.ended) return this.turn.fail(failure);
    if (this.harnessTurn) {
      this.harnessTurn = false;
      return this.harness({ type: "turn.failed", error: failure });
    }
    this.harness({ type: "crashed", message: failure.message });
  }

  private listen(event: SessionEvent) {
    this.relay.send(event);
  }

  private harness(event: SessionEvent) {
    this.relay.hold(event);
  }

  private ownerTurn() {
    return this.turn && !this.turn.ended ? this.turn : undefined;
  }

  /** A lead event goes to the owner's turn, else to an open harness-started turn. */
  private lead(event: HarnessEvent) {
    const owner = this.ownerTurn();
    if (owner) owner.push(event);
    else if (this.harnessTurn) this.harness(event);
  }

  /** The card of the sub-agent a tool call ran inside, if any. */
  private agentOf(toolUseId: string | undefined) {
    const task = toolUseId ? this.spawned.get(toolUseId) : undefined;
    return task && this.cards.has(task) ? task : undefined;
  }

  private canUseTool: CanUseTool = (name, input, options) =>
    new Promise<PermissionResult>((resolve) => {
      // A sub-agent's request is named by its card; an unmatched ID still marks it as a
      // sub-agent's so it never blocks the lead.
      const agent = options.agentID
        ? (this.agentOf(this.parents.get(options.toolUseID)) ??
          (this.cards.has(options.agentID) ? options.agentID : undefined) ??
          options.agentID)
        : undefined;
      const lead = !agent && (this.ownerTurn() || this.harnessTurn);
      if (!agent && !lead)
        return resolve({ behavior: "deny", message: "No turn is running." });
      const push = (event: HarnessEvent) =>
        agent
          ? this.listen({ ...event, agent } as HarnessEvent)
          : this.lead(event);
      const request = `${options.toolUseID || "tool"}:${++this.counter}`;
      options.signal.addEventListener("abort", () => {
        if (this.pending.delete(request))
          resolve({ behavior: "deny", message: "Cancelled." });
      });
      if (name === "AskUserQuestion") {
        const questions = (
          Array.isArray(input.questions) ? input.questions : []
        ).map((value, index): HarnessQuestion => {
          const question = object(value);
          return {
            id: String(index),
            header: string(question.header),
            question:
              string(question.question) || string(question.header) || "Question",
            options: (Array.isArray(question.options)
              ? question.options
              : []
            ).map((option) => ({
              label: string(object(option).label),
              description: string(object(option).description),
            })),
            multiSelect: question.multiSelect === true,
            allowOther: true,
            secret: false,
          };
        });
        this.pending.set(request, { kind: "question", input, resolve, agent });
        push({ type: "question", request, questions });
        return;
      }
      if (name === "ExitPlanMode") {
        this.pending.set(request, { kind: "plan", input, resolve, agent });
        push({
          type: "approval",
          request,
          plan: true,
          summary:
            string(input.plan) || "Claude Code is ready to leave plan mode.",
        });
        return;
      }
      if (this.loadout.access === "auto" && !this.loadout.planMode)
        return resolve({ behavior: "allow", updatedInput: input });
      this.pending.set(request, { kind: "approval", input, resolve, agent });
      push({
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
    const value = object(message);
    if (value.type === "system") return this.system(value);
    if (value.type === "rate_limit_event") {
      const info = object(value.rate_limit_info);
      if (info.status === "rejected" && typeof info.resetsAt === "number")
        this.resetsAt = info.resetsAt;
      return;
    }
    const parent = string(value.parent_tool_use_id) || undefined;
    // Sub-agent frames attach to their card; frames of other tasks are not shown.
    const agent = this.agentOf(parent);
    if (parent && !agent) return;
    if (value.type === "stream_event") {
      // Sub-agent deltas are skipped; their complete messages follow.
      if (parent) return;
      const event = object(value.event);
      if (event.type === "message_start")
        this.messageId = string(object(event.message).id);
      if (event.type === "content_block_delta") {
        const delta = object(event.delta);
        const item = `${this.messageId}:${event.index}`;
        if (delta.type === "text_delta")
          this.lead({
            type: "text",
            item,
            kind: "assistant",
            delta: string(delta.text),
          });
        if (delta.type === "thinking_delta")
          this.lead({
            type: "text",
            item,
            kind: "reasoning",
            delta: string(delta.thinking),
          });
      }
      return;
    }
    const emit = (event: HarnessEvent) =>
      agent
        ? this.listen({ ...event, agent } as HarnessEvent)
        : this.lead(event);
    if (value.type === "assistant") {
      const body = object(value.message);
      const id = string(body.id);
      const error = string(value.error);
      if (
        !agent &&
        (error === "authentication_failed" || error === "oauth_org_not_allowed")
      )
        this.failure = new HarnessError(
          "signed_out",
          "Claude Code is signed out.",
        );
      if (!agent && (error === "rate_limit" || error === "billing_error"))
        this.failure = new HarnessError(
          "usage_limit",
          "Claude Code reached its usage limit.",
          this.resetsAt,
        );
      // A complete lead message with no owner turn is a turn Claude Code started.
      if (!agent && !this.ownerTurn() && !this.harnessTurn) {
        this.harnessTurn = true;
        clearTimeout(this.idle);
        this.harness({ type: "turn.started" });
      }
      (Array.isArray(body.content) ? body.content : []).forEach(
        (raw, index) => {
          const block = object(raw);
          if (block.type === "tool_use") {
            const tool = string(block.id);
            const input = object(block.input);
            const summary = toolSummary(string(block.name), input);
            this.tools.set(tool, summary);
            if (parent) this.parents.set(tool, parent);
            emit({ type: "tool", item: tool, summary });
            if (!agent) this.plan(string(block.name), input, tool);
          } else if (block.type === "text")
            emit({
              type: "message",
              item: `${id}:${index}`,
              kind: "assistant",
              text: string(block.text),
            });
          else if (block.type === "thinking")
            emit({
              type: "message",
              item: `${id}:${index}`,
              kind: "reasoning",
              text: string(block.thinking),
            });
        },
      );
      return;
    }
    if (value.type === "user") {
      const content = object(value.message).content;
      for (const raw of Array.isArray(content) ? content : []) {
        const block = object(raw);
        if (block.type !== "tool_result") continue;
        const id = string(block.tool_use_id);
        emit({
          type: "tool",
          item: id,
          summary: `${this.tools.get(id) ?? "Tool"}${block.is_error ? " (failed)" : ""}`,
          detail: blockText(block.content),
        });
        const subject = this.creating.get(id);
        if (subject !== undefined && !block.is_error) {
          this.creating.delete(id);
          const created =
            string(object(object(value.tool_use_result).task).id) ||
            (/#(\d+)/.exec(blockText(block.content))?.[1] ?? "");
          if (created) {
            this.steps.push({ id: created, text: subject, status: "pending" });
            this.reportSteps();
          }
        }
      }
      return;
    }
    if (value.type === "result") {
      const uuids = [
        string(value.user_message_uuid),
        ...(Array.isArray(value.user_message_uuids)
          ? value.user_message_uuids.map(string)
          : []),
      ].filter(Boolean);
      const owner = this.ownerTurn();
      const failure = resultFailure(
        value,
        this.failure,
        Boolean(this.sessionId && !this.initialized),
        this.resetsAt,
      );
      this.failure = undefined;
      // A result answers the owner's send only when it names it (or, from older producers that
      // name nothing, when no harness turn is open).
      if (
        owner &&
        (uuids.length ? uuids.includes(this.owner) : !this.harnessTurn)
      )
        return failure ? owner.fail(failure) : owner.end();
      if (!this.harnessTurn) return;
      this.harnessTurn = false;
      this.harness(
        failure
          ? { type: "turn.failed", error: failure }
          : { type: "turn.completed" },
      );
      this.arm();
    }
  }

  private system(value: Record<string, unknown>) {
    const task = string(value.task_id);
    switch (value.subtype) {
      case "init": {
        this.initialized = true;
        const id = string(value.session_id);
        if (id && id !== this.sessionId) {
          this.sessionId = id;
          const owner = this.ownerTurn();
          if (owner) owner.push({ type: "session", sessionId: id });
          else this.listen({ type: "session", sessionId: id });
        }
        return;
      }
      case "task_started": {
        const tool = string(value.tool_use_id) || undefined;
        // Only real sub-agents get cards.
        if (
          value.task_type !== "local_agent" ||
          value.ambient === true ||
          value.skip_transcript === true
        )
          return;
        const parentKey = this.agentOf(tool && this.parents.get(tool));
        this.cards.set(task, { running: true });
        if (tool) this.spawned.set(tool, task);
        this.listen({
          type: "agent",
          key: task,
          ...(parentKey ? { parentKey } : {}),
          description: string(value.description) || "Sub-agent",
          ...(string(value.subagent_type)
            ? { agentType: string(value.subagent_type) }
            : {}),
          background: value.is_backgrounded === true,
          status: "running",
        });
        return;
      }
      case "task_progress": {
        if (!this.cards.get(task)?.running) return;
        const usage = object(value.usage);
        this.listen({
          type: "agent",
          key: task,
          ...(typeof usage.tool_uses === "number"
            ? { toolUses: usage.tool_uses }
            : {}),
          ...(string(value.last_tool_name)
            ? { latestTool: string(value.last_tool_name) }
            : {}),
        });
        return;
      }
      case "task_updated": {
        const card = this.cards.get(task);
        if (!card?.running) return;
        const patch = object(value.patch);
        const status =
          patch.status === "failed" || patch.status === "killed"
            ? AGENT_END[patch.status]
            : undefined;
        if (status) card.running = false;
        this.listen({
          type: "agent",
          key: task,
          ...(typeof patch.is_backgrounded === "boolean"
            ? { background: patch.is_backgrounded }
            : {}),
          ...(status ? { status } : {}),
          ...(status && string(patch.error)
            ? { summary: string(patch.error) }
            : {}),
        });
        return;
      }
      case "task_notification": {
        const card = this.cards.get(task);
        if (!card?.running) return;
        card.running = false;
        const usage = object(value.usage);
        const status =
          AGENT_END[string(value.status) as keyof typeof AGENT_END] ??
          "completed";
        this.listen({
          type: "agent",
          key: task,
          status,
          ...(string(value.summary) ? { summary: string(value.summary) } : {}),
          ...(typeof usage.tool_uses === "number"
            ? { toolUses: usage.tool_uses }
            : {}),
        });
        return;
      }
      case "background_tasks_changed": {
        this.background = new Set(
          (Array.isArray(value.tasks) ? value.tasks : [])
            .map(object)
            .filter((item) => item.ambient !== true)
            .map((item) => string(item.task_id)),
        );
        this.arm();
        return;
      }
    }
  }

  /** Maps the lead's to-do tools onto its plan. */
  private plan(name: string, input: Record<string, unknown>, tool: string) {
    if (name === "TodoWrite") {
      this.steps = (Array.isArray(input.todos) ? input.todos : []).map(
        (value, index) => {
          const todo = object(value);
          return {
            id: String(index),
            text: string(todo.content),
            status: STEP_STATUS[string(todo.status)] ?? "pending",
          };
        },
      );
      this.reportSteps();
    } else if (name === "TaskCreate")
      this.creating.set(tool, string(input.subject));
    else if (name === "TaskUpdate") {
      const index = this.steps.findIndex(
        (step) => step.id === string(input.taskId),
      );
      if (index < 0) return;
      if (input.status === "deleted") this.steps.splice(index, 1);
      else
        this.steps[index] = {
          ...this.steps[index],
          ...(string(input.subject) ? { text: string(input.subject) } : {}),
          ...(STEP_STATUS[string(input.status)]
            ? { status: STEP_STATUS[string(input.status)] }
            : {}),
        };
      this.reportSteps();
    }
  }

  private reportSteps() {
    this.lead({
      type: "steps",
      steps: this.steps.map(({ text, status }) => ({ text, status })),
    });
  }

  private denyAll(message: string, leadOnly = false) {
    for (const [request, pending] of this.pending)
      if (!leadOnly || !pending.agent) {
        pending.resolve({ behavior: "deny", message, interrupt: true });
        this.pending.delete(request);
      }
  }

  async *send(prompt: string, loadout: Loadout): AsyncIterable<HarnessEvent> {
    clearTimeout(this.idle);
    this.loadout = loadout;
    const turn = new EventQueue<HarnessEvent>();
    this.turn = turn;
    this.failure = undefined;
    this.owner = randomUUID();
    if (!this.query) this.start();
    else {
      // Streaming input keeps the loadout adjustable between turns.
      await this.query.setModel(loadout.model || undefined);
      await this.query.applyFlagSettings({
        effortLevel: loadout.effort ?? null,
      });
      await this.query.setPermissionMode(permissionMode(loadout));
    }
    this.channel!.push(prompt, this.owner);
    try {
      yield* turn;
    } finally {
      this.turn = undefined;
      // Sub-agent requests stay answerable after the lead's turn.
      this.denyAll("The turn ended.", true);
      this.relay.flush();
      this.arm();
    }
  }

  /**
   * Closes the query after ten idle minutes with no turn and no background work; the next send
   * resumes the session.
   */
  private arm() {
    clearTimeout(this.idle);
    if (this.relay.closed || this.adapter.closed) return;
    if (this.turn || this.harnessTurn || this.background.size) return;
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
            string(object(question).question),
            (answers[String(index)] ?? []).join(", "),
          ]),
        ),
      },
    });
  }

  /** Interrupts the lead and stops every background task, sub-agents included. */
  async stop() {
    this.denyAll("The host stopped the turn.");
    const query = this.query;
    if (!query) return;
    await query.interrupt();
    await Promise.all(
      [...this.background].map((task) => query.stopTask(task).catch(() => {})),
    );
  }

  close() {
    this.relay.closed = true;
    this.denyAll("The tab was closed.");
    this.turn?.end();
    this.release();
    this.adapter.forget(this);
  }
}

/** Claude Code through the Claude Agent SDK, one streaming-input query per open tab. */
export class ClaudeAdapter implements HarnessAdapter {
  readonly id = "claude" as const;
  // Anthropic's terms do not allow third-party products to offer claude.ai sign-in.
  readonly signIn = "guidance" as const;
  readonly reportsAgents = true;
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
