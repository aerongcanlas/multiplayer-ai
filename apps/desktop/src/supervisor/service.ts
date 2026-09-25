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
      this.importShared(input.room);
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
      // Harness I/O runs in the background and reports through snapshots (KTD16).
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
      command.type === "invite.create"
    )
      throw new Error(
        "Shared room operations require the main-process connection.",
      );
    if (command.type === "workspace.select")
      throw new Error("Repository selection requires the desktop file dialog.");
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
  private importShared(room: Snapshot["rooms"][number]) {
    if (!room.shared) throw new Error("Shared room identity is required.");
    this.transaction((draft) => {
      const index = draft.rooms.findIndex((item) => item.id === room.id);
      const old = draft.rooms[index];
      const sameAccount =
        old?.shared?.userId === room.shared?.userId &&
        old?.shared?.project === room.shared?.project;
      if (old && !sameAccount && old.tabs.some((tab) => tabBusy(tab.status)))
        throw new Error("Stop the previous account's running tabs first.");
      const next = sameAccount
        ? { ...room, workspace: old.workspace, tabs: old.tabs }
        : { ...room, tabs: [] };
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
