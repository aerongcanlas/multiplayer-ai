import { randomUUID } from "node:crypto";
import {
  commandSchema,
  currentSummary,
  type Command,
  type Execution,
  type Room,
  type Snapshot,
  type ProgressEvent,
  type Task,
  type PrivateWorkspace,
  type SupervisorRequest,
} from "../shared/contracts";
import { Journal } from "./journal";
import { MockRunner, type RunnerAdapter, type RunnerUpdate } from "./runner";
import { inspectWorkspace, publicWorkspace } from "./workspace";
import { CodexRunner, type CodexEvent } from "./codex-runner";

const now = () => new Date().toISOString();
const findRoom = (state: Snapshot, id: string) => {
  const room = state.rooms.find((room) => room.id === id);
  if (!room) throw new Error("Room not found on this desktop.");
  return room;
};
const findExecution = (room: Room, id: string) => {
  const execution = room.executions.find((execution) => execution.id === id);
  if (!execution) throw new Error("Execution not found in this room.");
  return execution;
};

export class SupervisorService {
  private state: Snapshot;
  private controllers = new Map<string, AbortController>();
  private closed = false;

  constructor(
    private journal: Journal,
    private publish: (snapshot: Snapshot) => void,
    private runner: RunnerAdapter = new MockRunner(),
    private codex?: CodexRunner,
    private openLogin?: (url: string) => void,
  ) {
    this.state = journal.load();
    this.transaction((draft, events) => {
      for (const room of draft.rooms) {
        for (const execution of room.executions.filter(
          (run) => run.status === "running",
        )) {
          execution.status = "blocked";
          execution.endedAt = now();
          execution.approvals = [];
          for (const task of execution.tasks.filter((task) =>
            ["running", "queued", "waiting_for_input"].includes(task.status),
          )) {
            task.status = "blocked";
            task.activity =
              "Desktop restarted during execution. Review before starting another run; no actions were replayed.";
            task.updatedAt = now();
          }
          this.record(
            execution,
            execution.tasks[0],
            "recovery",
            "Interrupted execution recovered as blocked. Automatic replay is disabled.",
            events,
          );
        }
      }
    });
    this.codex?.client.on("state", () => {
      if (!this.closed) this.transaction(() => {});
    });
  }

  snapshot(): Snapshot {
    return {
      ...structuredClone(this.state),
      ...(this.codex ? { provider: this.codex.client.snapshot() } : {}),
    };
  }

  private transaction(
    mutate: (draft: Snapshot, events: ProgressEvent[]) => void,
    workspace?: PrivateWorkspace,
  ) {
    const draft = structuredClone(this.state);
    const events: ProgressEvent[] = [];
    mutate(draft, events);
    draft.revision += 1;
    this.journal.save(draft, events, workspace);
    this.state = draft;
    this.publish(this.snapshot());
  }

  private record(
    execution: Execution,
    task: Task,
    type: ProgressEvent["type"],
    message: string,
    events: ProgressEvent[],
  ) {
    const event: ProgressEvent = {
      id: randomUUID(),
      seq: execution.events.length + 1,
      executionId: execution.id,
      taskId: task.id,
      agentId: task.agentId,
      generation: execution.generation,
      type,
      message,
      createdAt: now(),
    };
    execution.events.push(event);
    events.push(event);
  }

  async dispatch(input: SupervisorRequest["command"]): Promise<Snapshot> {
    if (this.closed) throw new Error("The supervisor is shutting down.");
    if (input.type === "shared.import") {
      if (!input.room.shared)
        throw new Error("Shared room identity is required.");
      this.transaction((draft) => {
        const index = draft.rooms.findIndex(
          (room) => room.id === input.room.id,
        );
        const old = draft.rooms[index];
        if (
          old &&
          (old.shared?.userId !== input.room.shared?.userId ||
            old.shared?.project !== input.room.shared?.project)
        ) {
          if (old.executions.some((run) => run.status === "running"))
            throw new Error("Stop the previous account execution first.");
        }
        const sameAccount =
          old?.shared?.userId === input.room.shared?.userId &&
          old?.shared?.project === input.room.shared?.project;
        const room = sameAccount
          ? {
              ...input.room,
              workspace: old.workspace,
              executions: old.executions,
              summaries: old.summaries,
            }
          : input.room;
        if (index < 0) draft.rooms.push(room);
        else draft.rooms[index] = room;
      });
      return this.snapshot();
    }
    // workspace.register is accepted only on the private main-to-supervisor transport.
    if (input.type === "workspace.register") {
      const room = findRoom(this.state, input.roomId);
      if (room.executions.some((run) => run.status === "running"))
        throw new Error("Stop the active run before changing the repository.");
      this.transaction((draft) => {
        findRoom(draft, input.roomId).workspace = publicWorkspace(
          input.workspace,
        );
      }, input.workspace);
      return this.snapshot();
    }
    const command = commandSchema.parse(input);
    if (command.type === "snapshot") return this.snapshot();
    if (command.type.startsWith("provider.")) {
      if (!this.codex) throw new Error("The Codex runtime is unavailable.");
      if (command.type === "provider.refresh")
        await this.codex.client.refresh();
      if (command.type === "provider.connect") {
        const url = await this.codex.client.connect();
        if (url) this.openLogin?.(url);
      }
      if (command.type === "provider.cancel")
        await this.codex.client.cancelLogin();
      if (command.type === "provider.disconnect") {
        if (this.controllers.size)
          throw new Error("Stop active work before signing out of Codex.");
        await this.codex.client.disconnect();
      }
      return this.snapshot();
    }
    if (command.type === "approval.respond") {
      const execution = findExecution(
        findRoom(this.state, command.roomId),
        command.executionId,
      );
      if (execution.status !== "running" || !this.codex)
        throw new Error("This execution has stopped.");
      this.codex.approve(
        command.executionId,
        command.approvalId,
        command.decision,
      );
      return this.snapshot();
    }
    // Narrow the provider commands before resolving a room below.
    if (
      command.type === "provider.refresh" ||
      command.type === "provider.connect" ||
      command.type === "provider.cancel" ||
      command.type === "provider.disconnect"
    )
      return this.snapshot();
    if (
      command.type === "auth.signIn" ||
      command.type === "auth.cancel" ||
      command.type === "auth.signOut" ||
      command.type === "shared.refresh" ||
      command.type === "room.join" ||
      command.type === "invite.create"
    )
      throw new Error(
        "Shared room operations require the main-process connection.",
      );
    if (command.type === "workspace.select")
      throw new Error("Repository selection requires the desktop file dialog.");
    if (command.type === "execution.start") return this.start(command);
    let stoppedId: string | undefined;
    this.transaction((draft, events) => {
      if (command.type === "room.create") {
        draft.rooms.push({
          id: randomUUID(),
          name: command.name,
          createdAt: now(),
          workspace: null,
          messages: [],
          suggestions: [],
          executions: [],
          summaries: [],
        });
        return;
      }
      const room = findRoom(draft, command.roomId);
      switch (command.type) {
        case "message.send":
          room.messages.push({
            id: randomUUID(),
            authorId: draft.hostId,
            authorName: "You",
            text: command.text,
            createdAt: now(),
          });
          break;
        case "suggestion.create": {
          // Reload canonical messages; renderer-supplied transcripts and authors are never accepted.
          const ids = new Set(command.messageIds);
          const sources = room.messages.filter((message) =>
            ids.has(message.id),
          );
          if (sources.length !== ids.size)
            throw new Error("A selected message does not belong to this room.");
          const contextVersion = currentSummary(room)?.version ?? 0;
          const prompt = `Using context version ${contextVersion}, consider this selected feedback:\n\n${sources.map((source) => `${source.authorName}: ${source.text}`).join("\n\n")}\n\nKeep conflicting advice visible and ask about missing requirements before making changes.`;
          if (prompt.length > 8_000)
            throw new Error(
              "Select fewer messages so the suggestion fits within 8,000 characters.",
            );
          room.suggestions.push({
            id: randomUUID(),
            prompt,
            contextVersion,
            sourceMessageIds: sources.map((source) => source.id),
            sources: structuredClone(sources),
            revision: 1,
            status: "draft",
            createdAt: now(),
            updatedAt: now(),
          });
          break;
        }
        case "suggestion.edit": {
          const suggestion = room.suggestions.find(
            (suggestion) => suggestion.id === command.suggestionId,
          );
          if (!suggestion)
            throw new Error("Suggestion not found in this room.");
          if (suggestion.status !== "draft")
            throw new Error(
              "Submitted suggestions are retained as execution evidence. Create a new suggestion to revise direction.",
            );
          if (suggestion.revision !== command.expectedRevision)
            throw new Error(
              "This suggestion changed. Reload the latest version before editing.",
            );
          suggestion.prompt = command.prompt;
          suggestion.revision += 1;
          suggestion.updatedAt = now();
          break;
        }
        case "execution.stop": {
          const execution = findExecution(room, command.executionId);
          if (execution.status !== "running")
            throw new Error("This execution has already stopped.");
          execution.status = "cancelled";
          execution.endedAt = now();
          for (const task of execution.tasks.filter((task) =>
            ["queued", "running", "waiting_for_input"].includes(task.status),
          )) {
            task.status = "cancelled";
            task.activity = "Stopped by the host.";
            task.updatedAt = now();
          }
          this.record(
            execution,
            execution.tasks[0],
            "status",
            "Host stopped the execution. Completed work and evidence were retained.",
            events,
          );
          stoppedId = execution.id;
          break;
        }
      }
    });
    if (stoppedId) this.controllers.get(stoppedId)?.abort();
    return this.snapshot();
  }

  private async start(
    command: Extract<Command, { type: "execution.start" }>,
  ): Promise<Snapshot> {
    if (this.controllers.size)
      throw new Error(
        "An active execution is still running or stopping. Wait before starting another run.",
      );
    if (command.runner === "codex" && (!this.codex || !command.configuration))
      throw new Error("Connect Codex and choose a model before running.");
    const initialRoom = findRoom(this.state, command.roomId);
    if (!initialRoom.workspace)
      throw new Error(
        "Select a local Git repository before starting an execution.",
      );
    const stored = this.journal.getWorkspace(initialRoom.workspace.id);
    if (!stored)
      throw new Error("Select the repository again to restore access.");
    const workspace = await inspectWorkspace(stored.path, stored.id);
    if (this.closed) throw new Error("The supervisor is shutting down.");
    const executionId = randomUUID();
    this.transaction((draft, events) => {
      const room = findRoom(draft, command.roomId);
      if (
        draft.rooms.some((room) =>
          room.executions.some((run) => run.status === "running"),
        )
      ) {
        throw new Error(
          "This desktop already has an active execution. Stop it or wait for completion.",
        );
      }
      const suggestion = command.suggestionId
        ? room.suggestions.find((item) => item.id === command.suggestionId)
        : null;
      if (command.suggestionId && !suggestion)
        throw new Error("Suggestion not found in this room.");
      const contextVersion = room.shared
        ? 0
        : (currentSummary(room)?.version ?? 0);
      if (
        suggestion &&
        (suggestion.contextVersion !== contextVersion ||
          suggestion.revision !== command.suggestionRevision)
      ) {
        throw new Error(
          "The suggestion refers to older context or an older edit. Generate a new suggestion from the current context.",
        );
      }
      if (suggestion?.status === "submitted")
        throw new Error("This suggestion was already submitted.");
      room.workspace = publicWorkspace(workspace);
      const taskIds = Array.from({ length: 4 }, () => randomUUID());
      const mockAssignments = [
        [
          "lead",
          "Coordinate the simulation",
          "All mock tasks complete and mock validation passes.",
        ],
        [
          "planner",
          "Plan a bounded task",
          "Record a simulated plan and acceptance criteria.",
        ],
        [
          "implementer",
          "Simulate implementation",
          "Emit a mock result without modifying files.",
        ],
        [
          "validator",
          "Simulate independent validation",
          "Record the selected mock validation outcome.",
        ],
      ] as const;
      const assignments =
        command.runner === "codex"
          ? ([
              [
                "lead",
                command.prompt,
                "Delegate bounded work, review specialist evidence, and report the outcome.",
              ],
            ] as const)
          : mockAssignments;
      const execution: Execution = {
        id: executionId,
        roomId: room.id,
        hostId: draft.hostId,
        generation: 1,
        planVersion: 1,
        runner: command.runner ?? "mock",
        ...(command.configuration
          ? { configuration: command.configuration, approvals: [] }
          : {}),
        scenario: command.scenario,
        workspace: publicWorkspace(workspace),
        prompt: command.prompt,
        contextVersion,
        sourceSuggestion: suggestion ? structuredClone(suggestion) : null,
        status: "running",
        startedAt: now(),
        endedAt: null,
        events: [],
        evidence: [],
        tasks: assignments.map(([role, objective, criteria], index) => ({
          id: taskIds[index],
          agentId: randomUUID(),
          parentId: index === 0 ? null : taskIds[0],
          role,
          objective,
          criteria,
          dependencies: index > 1 ? [taskIds[index - 1]] : [],
          status: "queued",
          contextVersion,
          inputRevision: workspace.revision,
          workspaceId: workspace.id,
          activity:
            command.runner === "codex"
              ? "Queued for Codex."
              : "Queued for the local mock runner.",
          updatedAt: now(),
          startedAt: null,
          completedAt: null,
        })),
      };
      if (suggestion && !room.shared) {
        suggestion.status = "submitted";
        suggestion.updatedAt = now();
      }
      room.executions.push(execution);
      this.record(
        execution,
        execution.tasks[0],
        "status",
        command.runner === "codex"
          ? `Host submitted a direction to Codex in ${command.configuration!.mode} mode.`
          : "Host submitted a direction to the mock runner. Simulation only; no repository changes.",
        events,
      );
    }, workspace);
    const controller = new AbortController();
    this.controllers.set(executionId, controller);
    if (command.runner === "codex")
      void this.runCodex(command.roomId, executionId, workspace, controller);
    else void this.run(command.roomId, executionId, command, controller);
    return this.snapshot();
  }

  private async runCodex(
    roomId: string,
    executionId: string,
    workspace: PrivateWorkspace,
    controller: AbortController,
  ) {
    try {
      const execution = structuredClone(
        findExecution(findRoom(this.state, roomId), executionId),
      );
      await this.codex!.run(
        {
          execution,
          workspace,
          configuration: execution.configuration!,
          signal: controller.signal,
        },
        (event) => this.applyCodexEvent(roomId, executionId, event),
      );
    } catch (error) {
      if (!this.closed && !controller.signal.aborted)
        this.transaction((draft, events) => {
          const execution = findExecution(findRoom(draft, roomId), executionId);
          execution.status = "failed";
          execution.endedAt = now();
          execution.approvals = [];
          const message =
            error instanceof Error ? error.message : "Codex execution failed.";
          for (const task of execution.tasks.filter((item) =>
            ["running", "queued", "waiting_for_input"].includes(item.status),
          )) {
            task.status = "failed";
            task.activity = message;
            task.completedAt = now();
            task.updatedAt = now();
          }
          this.record(execution, execution.tasks[0], "status", message, events);
        });
    } finally {
      this.controllers.delete(executionId);
    }
  }

  private applyCodexEvent(
    roomId: string,
    executionId: string,
    event: CodexEvent,
  ) {
    if (this.closed) return;
    if (event.type === "session") {
      this.journal.saveSession(executionId, event.taskId, event.threadId);
      return;
    }
    this.transaction((draft, events) => {
      const room = findRoom(draft, roomId);
      const execution = findExecution(room, executionId);
      if (execution.status !== "running" && event.type !== "approval.resolved")
        return;
      if (event.type === "task") {
        const index = execution.tasks.findIndex(
          (task) => task.id === event.task.id,
        );
        if (index < 0) execution.tasks.push(event.task);
        else execution.tasks[index] = event.task;
        this.record(
          execution,
          event.task,
          "status",
          `${event.task.role} assigned: ${event.task.objective}`,
          events,
        );
      } else if (event.type === "status" || event.type === "activity") {
        const task = execution.tasks.find((task) => task.id === event.taskId);
        if (!task) throw new Error("Unknown Codex task identity.");
        task.activity = event.message;
        task.updatedAt = now();
        if (event.type === "status") {
          task.status = event.status;
          if (event.status === "running") task.startedAt ??= now();
          if (["completed", "failed", "cancelled"].includes(event.status))
            task.completedAt = now();
        }
        this.record(execution, task, event.type, event.message, events);
      } else if (event.type === "evidence") {
        execution.evidence.push(event.evidence);
        const task = execution.tasks.find(
          (task) => task.id === event.evidence.taskId,
        )!;
        this.record(
          execution,
          task,
          "evidence",
          `${event.evidence.label}: ${event.evidence.outcome}`,
          events,
        );
      } else if (event.type === "approval")
        execution.approvals = [...(execution.approvals ?? []), event.approval];
      else if (event.type === "approval.resolved")
        execution.approvals = (execution.approvals ?? []).filter(
          (item) => item.id !== event.id,
        );
      else if (event.type === "artifact") execution.artifact = event.artifact;
      else if (event.type === "summary") {
        room.summaries.push({
          ...event.summary,
          version: (currentSummary(room)?.version ?? 0) + 1,
          createdAt: now(),
        });
        this.record(
          execution,
          execution.tasks[0],
          "summary",
          event.summary.currentWork,
          events,
        );
      } else if (event.type === "finished") {
        execution.status = event.succeeded ? "completed" : "failed";
        execution.endedAt = now();
        execution.approvals = [];
      }
    });
  }

  private async run(
    roomId: string,
    executionId: string,
    command: Extract<Command, { type: "execution.start" }>,
    controller: AbortController,
  ) {
    try {
      for await (const update of this.runner.run({
        ...command,
        signal: controller.signal,
      })) {
        if (this.closed || controller.signal.aborted) break;
        this.applyUpdate(roomId, executionId, update);
      }
    } catch {
      if (!controller.signal.aborted && !this.closed) {
        this.transaction((draft, events) => {
          const execution = findExecution(findRoom(draft, roomId), executionId);
          execution.status = "failed";
          execution.endedAt = now();
          for (const task of execution.tasks.filter((task) =>
            ["queued", "running"].includes(task.status),
          )) {
            task.status = "failed";
            task.activity = "Runner stopped unexpectedly.";
            task.updatedAt = now();
          }
          this.record(
            execution,
            execution.tasks[0],
            "status",
            "Runner failed. Review the retained activity before starting another execution.",
            events,
          );
        });
      }
    } finally {
      this.controllers.delete(executionId);
    }
  }

  private applyUpdate(
    roomId: string,
    executionId: string,
    update: RunnerUpdate,
  ) {
    this.transaction((draft, events) => {
      const room = findRoom(draft, roomId);
      const execution = findExecution(room, executionId);
      if (execution.status !== "running") return;
      const task = execution.tasks[update.taskIndex];
      if (!task) throw new Error("Runner referenced an unknown task.");
      if (
        update.status === "running" &&
        task.dependencies.some(
          (id) =>
            execution.tasks.find((task) => task.id === id)?.status !==
            "completed",
        )
      ) {
        throw new Error("Task dependencies are not complete.");
      }
      task.status = update.status;
      task.activity = update.message;
      task.updatedAt = now();
      if (update.status === "running") task.startedAt ??= now();
      if (["completed", "failed"].includes(update.status))
        task.completedAt = now();
      this.record(execution, task, "activity", update.message, events);
      if (update.evidence) {
        execution.evidence.push({
          id: randomUUID(),
          taskId: task.id,
          label: "Mock validation",
          kind: "simulation",
          ...update.evidence,
          revision: execution.workspace.revision,
          recordedAt: now(),
        });
        this.record(
          execution,
          task,
          "evidence",
          `Simulated validation ${update.evidence.outcome}.`,
          events,
        );
      }
      if (
        update.taskIndex === 0 &&
        ["completed", "failed"].includes(update.status)
      ) {
        const passed =
          execution.tasks.every((task) => task.status === "completed") &&
          execution.evidence.some((evidence) => evidence.outcome === "passed");
        execution.status = passed ? "completed" : "failed";
        execution.endedAt = now();
        room.summaries.push({
          version: (currentSummary(room)?.version ?? 0) + 1,
          executionId,
          goal: execution.prompt,
          decisions: [
            "Run remained local.",
            "Mock tasks did not modify the repository.",
          ],
          currentWork: passed
            ? "Simulation completed."
            : "Simulation stopped after a failed validation.",
          uncertainties: [
            "Real code changes and repository validation require a production runner adapter.",
          ],
          questions: [
            "What constraints or corrections should guide the next direction?",
          ],
          createdAt: now(),
        });
        this.record(
          execution,
          task,
          "summary",
          `Lead published context version ${currentSummary(room)?.version}.`,
          events,
        );
      }
    });
  }

  close() {
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.codex?.client.close();
    // Running tasks stay recorded. Startup recovery marks them blocked instead of replaying actions.
    this.journal.close();
  }
}
