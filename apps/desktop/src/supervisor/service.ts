import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  commandSchema,
  isHarnessCommand,
  type Command,
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
      else if (command.type === "harness.update")
        await registry.updateProgram(command.harness);
      else if (command.type === "harness.revertUpdate")
        registry.revertUpdate(command.harness);
      else if (command.type === "harness.setDefault")
        registry.setDefault(command.harness, command.model, command.effort);
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
    if (command.type === "suggestion.create")
      return { snapshot: await this.suggest(command) };
    if (isTabCommand(command))
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
        // A turn that used the suggestion keeps its own copy, so nothing else refers to it.
        case "suggestion.delete": {
          const index = room.suggestions.findIndex(
            (suggestion) => suggestion.id === command.suggestionId,
          );
          if (index < 0) throw new Error("Suggestion not found in this room.");
          room.suggestions.splice(index, 1);
          break;
        }
      }
    });
    return { snapshot: this.snapshot() };
  }

  private async suggest(
    command: Extract<Command, { type: "suggestion.create" }>,
  ) {
    const room = findRoom(this.state, command.roomId);
    const ids = new Set(command.messageIds);
    const sources = room.messages.filter((message) => ids.has(message.id));
    if (sources.length !== ids.size)
      throw new Error("A selected message does not belong to this room.");
    const registry = this.registry;
    if (!registry) throw new Error("Codex is unavailable in this build.");
    await registry.refresh("codex");
    if (!registry.ready("codex"))
      throw new Error(
        "Sign in with ChatGPT in Harness settings to generate prompts.",
      );
    const adapter = registry.adapter("codex");
    const models = registry.state("codex").models;
    const model = models.find((item) => item.isDefault) ?? models[0];
    if (!adapter.suggest || !model)
      throw new Error("Codex prompt generation is unavailable.");
    // Selected room messages are the only input; local tab transcripts remain private.
    const generated = await adapter.suggest({
      ...(await registry.context("codex")),
      messages: sources,
      model,
    });
    if (this.closed) throw new Error("The supervisor is shutting down.");
    this.transaction((draft) => {
      const current = findRoom(draft, room.id);
      if (
        current.shared?.userId !== room.shared?.userId ||
        current.shared?.project !== room.shared?.project
      )
        throw new Error(
          "Room membership or account changed. Generate suggestions again.",
        );
      for (const prompt of generated.suggestedPrompts)
        current.suggestions.push({
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
    });
    return this.snapshot();
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
