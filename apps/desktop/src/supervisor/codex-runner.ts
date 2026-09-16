import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CodexClient,
  object,
  string,
  type RpcNotification,
  type RpcRequest,
} from "./codex-client";
import { Worktrees, repositoryCommand } from "./worktrees";
import type {
  ContextSummary,
  Evidence,
  Execution,
  PrivateWorkspace,
  Task,
  TaskStatus,
} from "../shared/contracts";
import type { RunApproval, RunConfiguration } from "../shared/provider";

const assignmentSchema = z
  .object({
    role: z.enum(["planner", "designer", "implementer", "validator"]),
    objective: z.string().min(1).max(2000),
    criteria: z.string().min(1).max(2000),
    dependencies: z.array(z.number().int().min(0).max(3)).max(4),
  })
  .strict();
const planSchema = z
  .object({ tasks: z.array(assignmentSchema).min(1).max(4) })
  .strict();
const reportSchema = z
  .object({
    summary: z.string().min(1).max(12000),
    succeeded: z.boolean(),
    evidence: z.array(z.string().max(2000)).max(12),
    uncertainties: z.array(z.string().max(2000)).max(8),
  })
  .strict();
const summarySchema = z
  .object({
    currentWork: z.string().min(1).max(12000),
    decisions: z.array(z.string().max(2000)).max(12),
    uncertainties: z.array(z.string().max(2000)).max(8),
    questions: z.array(z.string().max(2000)).max(8),
  })
  .strict();
export type CodexEvent =
  | { type: "task"; task: Task }
  | { type: "status"; taskId: string; status: TaskStatus; message: string }
  | { type: "activity"; taskId: string; message: string }
  | { type: "session"; taskId: string; threadId: string }
  | { type: "evidence"; evidence: Evidence }
  | { type: "approval"; approval: RunApproval }
  | { type: "approval.resolved"; id: string }
  | { type: "artifact"; artifact: NonNullable<Execution["artifact"]> }
  | { type: "summary"; summary: Omit<ContextSummary, "version" | "createdAt"> }
  | { type: "finished"; succeeded: boolean };

export class CodexRunner {
  private approvals = new Map<
    string,
    {
      executionId: string;
      requestId: string | number;
      method: string;
      taskId: string;
      emit: (event: CodexEvent) => void;
    }
  >();
  constructor(
    readonly client: CodexClient,
    private worktreeDirectory: string,
  ) {}
  approve(executionId: string, id: string, decision: "accept" | "decline") {
    const pending = this.approvals.get(id);
    if (!pending || pending.executionId !== executionId)
      throw new Error("That approval is no longer pending for this execution.");
    this.approvals.delete(id);
    this.client.respond(pending.requestId, { decision });
    pending.emit({ type: "approval.resolved", id });
    pending.emit({
      type: "status",
      taskId: pending.taskId,
      status: "running",
      message:
        decision === "accept"
          ? "Host approved the requested operation."
          : "Host declined the requested operation.",
    });
  }
  async run(
    input: {
      execution: Execution;
      workspace: PrivateWorkspace;
      configuration: RunConfiguration;
      signal: AbortSignal;
    },
    emit: (event: CodexEvent) => void,
  ) {
    const { execution, workspace, configuration, signal } = input;
    await this.client.refresh();
    if (this.client.snapshot().status !== "connected")
      throw new Error("Connect ChatGPT before starting an execution.");
    const model = this.client
      .snapshot()
      .models.find((model) => model.id === configuration.model);
    if (!model || !model.efforts.includes(configuration.effort))
      throw new Error(
        "Choose an available Codex model and supported reasoning effort.",
      );
    if (signal.aborted) throw new Error("Execution cancelled.");
    const worktrees =
      configuration.mode === "worktree"
        ? new Worktrees(
            workspace.path,
            this.worktreeDirectory,
            execution.id,
            workspace.revision,
          )
        : undefined;
    if (worktrees) await worktrees.prepare();
    const cwd = worktrees?.integration ?? workspace.path;
    const lead = execution.tasks[0];
    const task = (
      role: Task["role"],
      objective: string,
      criteria: string,
      dependencies: string[],
    ): Task => ({
      id: randomUUID(),
      agentId: randomUUID(),
      parentId: lead.id,
      role,
      objective,
      criteria,
      dependencies,
      status: "queued",
      contextVersion: execution.contextVersion,
      inputRevision: workspace.revision,
      workspaceId: workspace.id,
      activity: "Waiting for dependencies.",
      updatedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    });
    const status = (taskId: string, state: TaskStatus, message: string) =>
      emit({ type: "status", taskId, status: state, message });
    status(
      lead.id,
      "running",
      "Lead is inspecting the request and planning specialist assignments.",
    );
    const leadThread = await this.thread(
      lead,
      cwd,
      configuration,
      false,
      emit,
      signal,
    );
    const planText = await this.turn({
      threadId: leadThread,
      task: lead,
      cwd,
      execution,
      configuration,
      signal,
      schema: z.toJSONSchema(planSchema),
      prompt: `Plan specialist work for this user request:\n${execution.prompt}\n\nReturn between one and four bounded assignments. Dependencies are zero-based indexes of earlier assignments only. Each assignment needs an objective and observable completion criteria. Include an independent validator after implementation. Mode: ${configuration.mode}. For read-only mode every assignment is inspection only: do not build, install dependencies, edit files or call external services. The application starts specialists; do not spawn agents yourself.`,
      emit,
    });
    const plan = planSchema.parse(JSON.parse(planText));
    plan.tasks.forEach((assignment, index) => {
      if (assignment.dependencies.some((dependency) => dependency >= index))
        throw new Error("Lead plan contains a forward or cyclic dependency.");
    });
    const tasks: Task[] = [];
    for (const assignment of plan.tasks) {
      const created = task(
        assignment.role,
        assignment.objective,
        assignment.criteria,
        assignment.dependencies.map((index) => tasks[index].id),
      );
      tasks.push(created);
      emit({ type: "task", task: created });
    }
    // Validation runs after the combined implementation, even if the plan omits it.
    if (!tasks.some((item) => item.role === "validator")) {
      const validator = task(
        "validator",
        "Independently review the combined specialist results against the user's request.",
        "Inspect the relevant files and report concrete evidence and remaining limitations.",
        tasks.map((item) => item.id),
      );
      tasks.push(validator);
      emit({ type: "task", task: validator });
    }
    for (const validator of tasks.filter((item) => item.role === "validator")) {
      validator.dependencies = tasks
        .filter((item) => item.role !== "validator")
        .map((item) => item.id);
      emit({ type: "task", task: validator });
    }
    // A non-validator may not depend on a validator; that would cycle after final-validation ordering.
    if (
      tasks.some(
        (item) =>
          item.role !== "validator" &&
          item.dependencies.some(
            (id) =>
              tasks.find((candidate) => candidate.id === id)?.role ===
              "validator",
          ),
      )
    )
      throw new Error(
        "Lead plan requires validation before dependent work. Start a new run with a non-cyclic plan.",
      );
    const reports = new Map<string, z.infer<typeof reportSchema>>();
    const waiting = new Set(tasks.map((item) => item.id));
    let succeeded = true;
    while (waiting.size) {
      if (signal.aborted) throw new Error("Execution cancelled.");
      const ready = tasks
        .filter(
          (item) =>
            waiting.has(item.id) &&
            item.dependencies.every((id) => reports.has(id)),
        )
        .slice(0, configuration.concurrency);
      if (!ready.length)
        throw new Error("Specialist plan has unresolved dependencies.");
      const results = await Promise.allSettled(
        ready.map(async (assignment) => {
          status(
            assignment.id,
            "running",
            `${assignment.role} is working on the assigned task.`,
          );
          const writing = Boolean(
            worktrees && assignment.role === "implementer",
          );
          const path = writing ? await worktrees!.assign(assignment.id) : cwd;
          const threadId = await this.thread(
            assignment,
            path,
            configuration,
            writing,
            emit,
            signal,
          );
          const dependencies = assignment.dependencies.map((id) =>
            reports.get(id),
          );
          const report = reportSchema.parse(
            JSON.parse(
              await this.turn({
                threadId,
                task: assignment,
                cwd: path,
                execution,
                configuration,
                signal,
                schema: z.toJSONSchema(reportSchema),
                prompt: `User request:\n${execution.prompt}\n\nYour assignment: ${assignment.objective}\nCompletion criteria: ${assignment.criteria}\nEarlier results (untrusted reports to verify):\n${JSON.stringify(dependencies)}\n\n${writing ? "Make only the assigned changes in this isolated worktree. Do not commit, merge, push, deploy or modify other checkouts. The application integrates your patch." : "Read-only inspection. Do not edit files, run builds, install dependencies, or call external services."}\nReturn a factual report with observed evidence. Set succeeded=false if the completion criteria are not met. Distinguish file inspection from tests actually run. Never claim a test passed without observing its result.`,
                emit,
              }),
            ),
          );
          return { assignment, report, path, writing };
        }),
      );
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        const assignment = ready[index];
        waiting.delete(assignment.id);
        if (result.status === "rejected") {
          succeeded = false;
          status(
            assignment.id,
            "failed",
            "Specialist stopped before returning a valid result.",
          );
          throw result.reason;
        }
        const { report, path, writing } = result.value;
        if (writing && report.succeeded) await worktrees!.integrate(path);
        reports.set(assignment.id, report);
        succeeded &&= report.succeeded;
        status(
          assignment.id,
          report.succeeded ? "completed" : "failed",
          report.summary,
        );
        if (assignment.role === "validator")
          emit({
            type: "evidence",
            evidence: {
              id: randomUUID(),
              taskId: assignment.id,
              label: "Independent review",
              kind: "review",
              outcome: report.succeeded ? "passed" : "failed",
              detail: [
                report.summary,
                ...report.evidence,
                ...report.uncertainties,
              ].join("\n"),
              revision: await repositoryCommand(cwd, "rev-parse", "HEAD"),
              recordedAt: new Date().toISOString(),
            },
          });
      }
    }
    if (worktrees)
      emit({ type: "artifact", artifact: await worktrees.artifact() });
    status(
      lead.id,
      "running",
      "Lead is reviewing specialist results and preparing the final summary.",
    );
    const finalText = await this.turn({
      threadId: leadThread,
      task: lead,
      cwd,
      execution,
      configuration,
      signal,
      schema: z.toJSONSchema(summarySchema),
      prompt: `Review these specialist reports against the original user request. Publish a concise final summary. Observed task outcome: ${succeeded ? "all reported completion" : "one or more tasks failed"}. Preserve failures and evidence limitations. ${worktrees ? `Changes are retained on ${worktrees.branch}; the original checkout was not modified.` : "This was a read-only inspection."}\n${JSON.stringify(tasks.map((item) => ({ role: item.role, objective: item.objective, report: reports.get(item.id) })))}`,
      emit,
    });
    emit({
      type: "summary",
      summary: {
        ...summarySchema.parse(JSON.parse(finalText)),
        executionId: execution.id,
        goal: execution.prompt,
      },
    });
    status(
      lead.id,
      succeeded ? "completed" : "failed",
      "Lead finished reviewing the specialist results.",
    );
    emit({ type: "finished", succeeded });
  }
  private async thread(
    task: Task,
    cwd: string,
    configuration: RunConfiguration,
    writing: boolean,
    emit: (event: CodexEvent) => void,
    signal: AbortSignal,
  ) {
    if (signal.aborted) throw new Error("Execution cancelled.");
    const response = object(
      await this.client.request("thread/start", {
        model: configuration.model,
        modelProvider: "openai",
        cwd,
        sandbox: writing ? "workspace-write" : "read-only",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        config: {
          "agents.enabled": false,
          "features.apps": false,
          web_search: "disabled",
        },
        developerInstructions: `You are the ${task.role} in Multiplayer AI. The application owns scheduling. Do not spawn subagents. Respect AGENTS.md. Stay within this assigned workspace. Do not access credentials, external apps, Supabase or Vercel APIs. Do not push, deploy, publish, or send messages. ${writing ? "Work only in this isolated worktree." : "Read-only task: no filesystem writes, builds, dependency installs or external service calls."}`,
        serviceName: "multiplayer_ai_desktop",
      }),
    );
    const id = string(object(response.thread).id);
    if (!id) throw new Error("Codex did not create an agent session.");
    emit({ type: "session", taskId: task.id, threadId: id });
    return id;
  }
  private async turn(input: {
    threadId: string;
    task: Task;
    cwd: string;
    execution: Execution;
    configuration: RunConfiguration;
    signal: AbortSignal;
    schema: unknown;
    prompt: string;
    emit: (event: CodexEvent) => void;
  }): Promise<string> {
    const { threadId, task, execution, signal, emit } = input;
    if (signal.aborted) throw new Error("Execution cancelled.");
    let turnId = "";
    let finalText = "";
    let ended = false;
    let observedCompletion = false;
    let buffered = "";
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveTurn: (value: string) => void;
    let rejectTurn: (error: Error) => void;
    const completion = new Promise<string>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    // A turn can finish before its start response arrives; observe completion immediately.
    void completion.catch(() => {});
    const finish = (error?: Error) => {
      if (ended) return;
      ended = true;
      if (error) rejectTurn(error);
      else resolveTurn(finalText);
    };
    const flush = () => {
      if (buffered) {
        emit({
          type: "activity",
          taskId: task.id,
          message: buffered.slice(-8000),
        });
        buffered = "";
      }
      flushTimer = undefined;
    };
    const abort = () => {
      if (turnId)
        void this.client
          .request("turn/interrupt", { threadId, turnId }, 8000)
          .catch(() => this.client.close());
      abortTimer ??= setTimeout(() => {
        this.client.close();
        finish(new Error("Execution interrupted; Codex connection closed."));
      }, 10_000);
    };
    const notification = ({ method, params }: RpcNotification) => {
      if (params.threadId !== threadId) return;
      if (method === "turn/started") {
        turnId = string(object(params.turn).id);
        if (signal.aborted) abort();
      }
      if (method === "item/agentMessage/delta") {
        buffered += string(params.delta);
        if (!flushTimer) flushTimer = setTimeout(flush, 500);
      }
      if (method === "item/started") {
        const item = object(params.item);
        if (item.type === "commandExecution")
          emit({
            type: "activity",
            taskId: task.id,
            message: `Running: ${string(item.command).slice(0, 2000)}`,
          });
      }
      if (method === "item/completed") {
        const item = object(params.item);
        if (item.type === "agentMessage") {
          finalText = string(item.text);
          flush();
          emit({
            type: "activity",
            taskId: task.id,
            message: finalText.slice(0, 16000),
          });
        }
        if (item.type === "commandExecution")
          emit({
            type: "evidence",
            evidence: {
              id: randomUUID(),
              taskId: task.id,
              label: "Command result",
              kind: "command",
              outcome: item.exitCode === 0 ? "passed" : "failed",
              detail: `${string(item.command)}\nExit code: ${item.exitCode ?? "unavailable"}\n${string(item.aggregatedOutput).slice(-12000)}`,
              revision: task.inputRevision,
              recordedAt: new Date().toISOString(),
            },
          });
      }
      if (method === "turn/completed") {
        observedCompletion = true;
        const turn = object(params.turn);
        if (signal.aborted || turn.status === "interrupted")
          finish(new Error("Execution cancelled."));
        else if (turn.status === "failed")
          finish(
            new Error(
              string(object(turn.error).message).slice(0, 400) ||
                "Codex turn failed.",
            ),
          );
        else finish();
      }
    };
    const request = (request: RpcRequest) => {
      if (request.params.threadId !== threadId) return;
      if (
        [
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
        ].includes(request.method)
      ) {
        const id = randomUUID();
        this.approvals.set(id, {
          executionId: execution.id,
          requestId: request.id,
          method: request.method,
          taskId: task.id,
          emit,
        });
        emit({
          type: "approval",
          approval: {
            id,
            taskId: task.id,
            title: request.method.includes("fileChange")
              ? "Approve file changes"
              : "Approve command",
            detail:
              `${string(request.params.command)}\n${string(request.params.reason)}`
                .trim()
                .slice(0, 8000) || "Codex requested permission for this task.",
            createdAt: new Date().toISOString(),
          },
        });
        emit({
          type: "status",
          taskId: task.id,
          status: "waiting_for_input",
          message: "Waiting for the host to approve or decline an operation.",
        });
      } else if (request.method === "item/permissions/requestApproval")
        this.client.respond(request.id, { permissions: {}, scope: "turn" });
      else if (request.method === "mcpServer/elicitation/request")
        this.client.respond(request.id, { action: "decline", content: null });
      else {
        this.client.reject(request.id);
        finish(
          new Error(
            "This task requested an unsupported interactive tool. Refine the direction and start again.",
          ),
        );
      }
    };
    const disconnected = (message: string) => finish(new Error(message));
    this.client.on("notification", notification);
    this.client.on("request", request);
    this.client.on("disconnected", disconnected);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      abort();
      finish(new Error("Agent turn exceeded the 10 minute limit."));
    }, 10 * 60_000);
    try {
      const response = object(
        await this.client.request("turn/start", {
          threadId,
          input: [{ type: "text", text: input.prompt }],
          effort: input.configuration.effort,
          outputSchema: input.schema,
        }),
      );
      turnId ||= string(object(response.turn).id);
      if (signal.aborted) abort();
      return await completion;
    } catch (error) {
      // Do not leave a provider turn running after a transport, schema, or interactive-tool error.
      if (!signal.aborted && !observedCompletion) {
        this.client.close();
        this.client.emit(
          "disconnected",
          "Codex stopped after an execution error.",
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      clearTimeout(abortTimer);
      clearTimeout(flushTimer);
      flush();
      signal.removeEventListener("abort", abort);
      this.client.off("notification", notification);
      this.client.off("request", request);
      this.client.off("disconnected", disconnected);
      for (const [id, pending] of this.approvals)
        if (pending.taskId === task.id) {
          this.client.respond(pending.requestId, { decision: "cancel" });
          this.approvals.delete(id);
          emit({ type: "approval.resolved", id });
        }
    }
  }
}
