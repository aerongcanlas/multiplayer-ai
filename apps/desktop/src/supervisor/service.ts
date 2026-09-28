import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  commandSchema,
  isHarnessCommand,
  type Snapshot,
  type PrivateWorkspace,
  type SupervisorRequest,
} from "../shared/contracts";
import {
  tabBusy,
  type TranscriptBatch,
  type TranscriptPage,
} from "../shared/tabs";
import { Journal } from "./journal";
import { publicWorkspace } from "./workspace";
import type { HarnessRegistry } from "./harnesses/registry";
import { TabHost, type TabCommand } from "./tabs/host";
import { TranscriptWriter } from "./tabs/transcript";

const now = () => new Date().toISOString();
const findRoom = (state: Snapshot, id: string) => {
  const room = state.rooms.find((room) => room.id === id);
  if (!room) throw new Error("Room not found on this desktop.");
  return room;
};
const isTabCommand = (input: SupervisorRequest["command"]) =>
  input.type.startsWith("tab.") ||
  input.type === "question.answer" ||
  input.type === "approval.respond";

export class SupervisorService {
  private state: Snapshot;
  private closed = false;
  private host?: TabHost;
  private registry?: HarnessRegistry;

  constructor(
    private journal: Journal,
    private publish: (snapshot: Snapshot) => void,
    harnesses?: {
      registry: HarnessRegistry;
      publishTranscript: (batches: TranscriptBatch[]) => void;
      transcriptInterval?: number;
      stopTimeoutMs?: number;
    },
  ) {
    this.state = journal.load();
    if (!harnesses) return;
    this.registry = harnesses.registry;
    this.host = new TabHost(
      {
        read: () => this.state,
        transaction: (mutate) => this.transaction(mutate),
        workspacePath: (roomId) => {
          const workspace = this.state.rooms.find(
            (room) => room.id === roomId,
          )?.workspace;
          return workspace
            ? (journal.getWorkspace(workspace.id)?.path ?? null)
            : null;
        },
        transcriptPage: (tabId, beforeSeq, limit, agentKey) =>
          journal.transcriptPage(tabId, beforeSeq, limit, agentKey),
        transcriptSince: (tabId, afterSeq, limit) =>
          journal.transcriptSince(tabId, afterSeq, limit),
        agentCards: (tabId) => journal.agentCards(tabId),
        pendingEntries: (tabId) => journal.pendingEntries(tabId),
        deleteTranscript: (tabId) => journal.deleteTranscript(tabId),
      },
      harnesses.registry,
      new TranscriptWriter(
        journal,
        harnesses.publishTranscript,
        harnesses.transcriptInterval,
      ),
      harnesses.stopTimeoutMs,
    );
    this.host.recover();
    // Restored tabs need their harness's sign-in and models before they can send again.
    for (const harness of new Set(
      this.state.rooms.flatMap((room) =>
        room.tabs.map((tab) => tab.loadout.harness),
      ),
    ))
      void harnesses.registry.refresh(harness);
  }

  snapshot(): Snapshot {
    return {
      ...structuredClone(this.state),
      protocolVersion: PROTOCOL_VERSION,
      ...(this.registry ? { harnesses: this.registry.snapshot() } : {}),
    };
  }

  /** Harness program, sign-in, or model state changed; it is not journaled. */
  harnessesChanged() {
    if (this.closed) return;
    this.state = { ...this.state, revision: this.state.revision + 1 };
    this.publish(this.snapshot());
    this.host?.syncStatuses();
  }

  private transaction(
    mutate: (draft: Snapshot) => void,
    workspace?: PrivateWorkspace,
  ) {
    const draft = structuredClone(this.state);
    mutate(draft);
    draft.revision += 1;
    this.journal.save(draft, workspace);
    this.state = draft;
    this.publish(this.snapshot());
  }

  async dispatch(input: SupervisorRequest["command"]): Promise<Snapshot> {
    return (await this.dispatchResult(input)).snapshot;
  }

  /** Dispatches a command and returns the snapshot plus a transcript page when one was asked for. */
  async dispatchResult(
    input: SupervisorRequest["command"],
  ): Promise<{ snapshot: Snapshot; transcript?: TranscriptPage }> {
    if (this.closed) throw new Error("The supervisor is shutting down.");
    // Main-only messages from the private transport.
    if (input.type === "host.environment") {
      this.registry?.setEnvironment(input.env);
      return { snapshot: this.snapshot() };
    }
    if (input.type === "harness.setExecutable") {
      if (!this.registry)
        throw new Error("Harnesses are unavailable in this build.");
      this.registry.setExecutable(input.harness, input.path);
      void this.registry.refresh(input.harness);
      return { snapshot: this.snapshot() };
    }
    if (input.type === "shared.import") {
      await this.importShared(input.room);
      return { snapshot: this.snapshot() };
    }
    // workspace.register is accepted only on the private main-to-supervisor transport.
    if (input.type === "workspace.register") {
      const room = findRoom(this.state, input.roomId);
      if (room.tabs.some((tab) => tabBusy(tab.status)))
        throw new Error("Stop running tabs before changing the repository.");
      this.transaction((draft) => {
        findRoom(draft, input.roomId).workspace = publicWorkspace(
          input.workspace,
        );
      }, input.workspace);
      return { snapshot: this.snapshot() };
    }
    if (isTabCommand(input)) {
      if (!this.host)
        throw new Error("Chat tabs are unavailable in this build.");
      const transcript = await this.host.handle(
        commandSchema.parse(input) as TabCommand,
      );
      return {
        snapshot: this.snapshot(),
        ...(transcript ? { transcript } : {}),
      };
    }
    const command = commandSchema.parse(input);
    if (command.type === "snapshot") return { snapshot: this.snapshot() };
    if (isHarnessCommand(command)) {
      const registry = this.registry;
      if (!registry)
        throw new Error("Harnesses are unavailable in this build.");
      // Harness I/O runs in the background and reports through snapshots.
      if (command.type === "harness.refresh")
        void registry.refresh(command.harness);
      else if (command.type === "harness.signIn")
        void registry.signIn(command.harness).catch(() => {
          /* The failure is recorded in the harness state. */
        });
      else if (command.type === "harness.useManaged") {
        registry.setExecutable(command.harness, null);
        void registry.refresh(command.harness);
      } else if (command.type === "harness.acknowledgeNotice")
        registry.acknowledgeNotice(command.harness);
      else
        throw new Error(
          "Choosing an executable requires the desktop file dialog.",
        );
      return { snapshot: this.snapshot() };
    }
    if (
      command.type === "auth.signIn" ||
      command.type === "auth.cancel" ||
      command.type === "auth.signOut" ||
      command.type === "shared.refresh" ||
      command.type === "room.join" ||
      command.type === "invite.create" ||
      command.type === "sharedTab.watch" ||
      command.type === "sharedTab.unwatch" ||
      command.type === "sharedTab.load"
    )
      throw new Error(
        "Shared room operations require the main-process connection.",
      );
    if (command.type === "workspace.select")
      throw new Error("Repository selection requires the desktop file dialog.");
    if (isTabCommand(command))
    if (command.type === "suggestion.create") return this.suggest(command);
      throw new Error("Chat tabs are unavailable in this build.");
    this.transaction((draft) => {
      if (command.type === "room.create") {
        draft.rooms.push({
          id: randomUUID(),
          name: command.name,
          createdAt: now(),
          workspace: null,
          messages: [],
          suggestions: [],
          tabs: [],
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
          const prompt = `Consider this selected feedback from the room:\n\n${sources.map((source) => `${source.authorName}: ${source.text}`).join("\n\n")}\n\nKeep conflicting advice visible and ask about missing requirements before making changes.`;
          if (prompt.length > 8_000)
            throw new Error(
              "Select fewer messages so the suggestion fits within 8,000 characters.",
            );
          room.suggestions.push({
            id: randomUUID(),
            prompt,
            contextVersion: 0,
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
              "Submitted suggestions are kept with the turn that used them. Create a new suggestion to revise direction.",
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
      }
    });
    return { snapshot: this.snapshot() };
  }

  // Shared rooms keep this host's private repository selection and tabs for the same account.
  private async importShared(room: Snapshot["rooms"][number]) {
    if (!room.shared) throw new Error("Shared room identity is required.");
    const previous = this.state.rooms.find((item) => item.id === room.id);
    if (
      previous &&
      (previous.shared?.userId !== room.shared.userId ||
        previous.shared?.project !== room.shared.project)
    ) {
      if (previous.tabs.some((tab) => tabBusy(tab.status) || tab.runningAgents))
        throw new Error("Stop the previous account's running tabs first.");
      // Remove the previous account's tabs fully, closed ones included: sessions, live state,
      // and transcripts.
      this.host?.purge(room.id);
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

  private async suggest(
    command: Extract<Command, { type: "suggestion.create" }>,
  ) {
    const room = findRoom(this.state, command.roomId);
    const ids = new Set(command.messageIds);
    const sources = room.messages.filter((message) => ids.has(message.id));
    if (sources.length !== ids.size)
      throw new Error("A selected message does not belong to this room.");
    if (!this.codex)
      throw new Error("Connect ChatGPT to generate prompt suggestions.");
    // Shared suggestions only use shared messages, never this host's private lead context.
    const context = room.shared ? undefined : currentSummary(room);
    const contextVersion = context?.version ?? 0;
    const generated = await this.codex.suggest(sources, context);
    if (this.closed) throw new Error("The supervisor is shutting down.");
    this.transaction((draft) => {
      const current = findRoom(draft, room.id);
      if (
        current.shared?.userId !== room.shared?.userId ||
        current.shared?.project !== room.shared?.project ||
        (!current.shared &&
          (currentSummary(current)?.version ?? 0) !== contextVersion)
      )
        throw new Error("Room context changed. Generate suggestions again.");
      for (const prompt of generated.suggestedPrompts) {
        current.suggestions.push({
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
      }
    });
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
    this.transaction((draft) => {
      const index = draft.rooms.findIndex((item) => item.id === room.id);
      const old = draft.rooms[index];
      const sameAccount =
        old?.shared?.userId === room.shared?.userId &&
        old?.shared?.project === room.shared?.project;
      const next = sameAccount
        ? {
            ...room,
            workspace: old.workspace,
            tabs: old.tabs,
            closedTabs: old.closedTabs ?? [],
          }
        : { ...room, tabs: [], closedTabs: [] };
      if (index < 0) draft.rooms.push(next);
      else draft.rooms[index] = next;
    });
  }

  close() {
    this.host?.close();
    this.registry?.close();
    this.closed = true;
    // Running turns stay recorded; startup recovery marks them interrupted instead of replaying.
    this.journal.close();
  }
}
