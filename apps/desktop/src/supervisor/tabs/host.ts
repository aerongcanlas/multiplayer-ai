import { randomUUID } from "node:crypto";
import type { Command, Room, Snapshot } from "../../shared/contracts";
import {
  DEFAULT_LOADOUT,
  HARNESS_LABELS,
  tabBusy,
  type AgentCard,
  type Loadout,
  type Tab,
  type TranscriptEntry,
  type TranscriptPage,
} from "../../shared/tabs";
import {
  HarnessError,
  type HarnessEvent,
  type HarnessSession,
  type SessionEvent,
} from "../harnesses/contract";
import type { HarnessRegistry } from "../harnesses/registry";
import { oneLine, type TranscriptWriter } from "./transcript";

export type TabCommand = Extract<
  Command,
  { type: `tab.${string}` | "question.answer" | "approval.respond" }
>;

export interface HostStore {
  read(): Snapshot;
  transaction(mutate: (draft: Snapshot) => void): void;
  workspacePath(roomId: string): string | null;
  transcriptPage(
    tabId: string,
    beforeSeq?: number,
    limit?: number,
    agentKey?: string,
  ): TranscriptPage;
  agentCards(tabId: string): TranscriptEntry[];
  pendingEntries(tabId: string): TranscriptEntry[];
  agentCards(tabId: string): TranscriptEntry[];
  deleteTranscript(tabId: string): void;
}

interface Turn {
  id: string;
  roomId: string;
  // A lead turn the harness started by itself.
  harness: boolean;
  stopping: boolean;
  finished: boolean;
  stopTimer?: ReturnType<typeof setTimeout>;
}
interface Live {
  session?: HarnessSession;
  turn?: Turn;
  // Transcript entry ID -> the harness's request, for approvals and questions still pending.
  // Requests with an agent key come from sub-agents and never block the tab.
  requests: Map<string, { request: string; agentKey?: string }>;
  // Sub-agent key -> its card entry and the turn its entries file under.
  cards: Map<string, { entryId: string; turnId: string | null }>;
  // A Stop that found only sub-agents running.
  stopTimer?: ReturnType<typeof setTimeout>;
}
type AgentEvent = Extract<HarnessEvent, { type: "agent" }>;

const NOTES = {
  stopped: "Stopped before finishing",
  interrupted: "Interrupted before finishing",
} as const;

const now = () => new Date().toISOString();
const STOP_TIMEOUT_MS = 10_000;

function findTab(
  state: Snapshot,
  roomId: string,
  tabId: string,
): { room: Room; tab: Tab } {
  const room = state.rooms.find((room) => room.id === roomId);
  const tab = room?.tabs.find((tab) => tab.id === tabId);
  if (!room || !tab)
    throw new Error("That tab is no longer open in this room.");
  return { room, tab };
}

/**
 * Owns tab lifecycle and turns. One turn runs per tab at a time; tabs run concurrently. Adapters
 * never touch the journal or the snapshot; everything they report lands here.
 */
export class TabHost {
  private live = new Map<string, Live>();
  private closed = false;

  constructor(
    private store: HostStore,
    private registry: HarnessRegistry,
    private writer: TranscriptWriter,
    private stopTimeoutMs = STOP_TIMEOUT_MS,
  ) {}

  /**
   * After an app restart, running turns and sub-agents are interrupted and pending requests are
   * cleared.
   */
  recover() {
    const tabs: { roomId: string; tabId: string; busy: boolean }[] = [];
    this.store.transaction((draft) => {
      for (const room of draft.rooms)
        for (const tab of room.tabs) {
          const busy = tabBusy(tab.status);
          tabs.push({ roomId: room.id, tabId: tab.id, busy });
          if (busy) tab.status = "interrupted";
          if (busy || tab.runningAgents || tab.agentRequests) {
            delete tab.runningAgents;
            delete tab.agentRequests;
            tab.updatedAt = now();
          }
        }
    });
    for (const { roomId, tabId, busy } of tabs) {
      const pending = this.store.pendingEntries(tabId);
      const running = this.store
        .agentCards(tabId)
        .filter((entry) => entry.agent?.status === "running");
      if (!busy && !pending.length && !running.length) continue;
      for (const entry of pending) {
        this.writer.adopt(roomId, entry);
        this.writer.update(entry.id, { state: "cancelled" });
      }
      for (const entry of running) {
        this.writer.adopt(roomId, entry);
        this.endCard(entry.id, entry.agent!, "interrupted");
      }
      if (busy)
        this.writer.append(roomId, tabId, {
          turnId: null,
          kind: "notice",
          notice: "interrupted",
          summary:
            "The app restarted during this turn. It was interrupted; send a follow-up to continue.",
        });
      this.writer.release(tabId);
    }
  }

  private liveOf(tabId: string): Live {
    let live = this.live.get(tabId);
    if (!live) {
      live = { requests: new Map(), cards: new Map() };
      this.live.set(tabId, live);
    }
    return live;
  }

  private ready(tab: Tab) {
    return this.registry.ready(tab.loadout.harness);
  }

  /** Aligns idle tabs with harness readiness and fills in default models once they are known. */
  syncStatuses() {
    const changes: {
      roomId: string;
      tabId: string;
      status: Tab["status"];
      loadout?: Loadout;
    }[] = [];
    for (const room of this.store.read().rooms)
      for (const tab of room.tabs) {
        const ready = this.ready(tab);
        const status =
          tab.status === "idle" && !ready
            ? "unavailable"
            : tab.status === "unavailable" && ready
              ? "idle"
              : tab.status;
        const loadout =
          !tab.loadout.model && !tabBusy(tab.status)
            ? this.withDefaultModel(tab.loadout)
            : undefined;
        if (status !== tab.status || (loadout && loadout.model))
          changes.push({
            roomId: room.id,
            tabId: tab.id,
            status,
            ...(loadout?.model ? { loadout } : {}),
          });
      }
    if (!changes.length) return;
    this.store.transaction((draft) => {
      for (const change of changes) {
        const { tab } = findTab(draft, change.roomId, change.tabId);
        tab.status = change.status;
        if (change.loadout) tab.loadout = change.loadout;
        tab.updatedAt = now();
      }
    });
  }

  private withDefaultModel(loadout: Loadout): Loadout {
    const models = this.registry.state(loadout.harness).models;
    const model = models.find((model) => model.isDefault) ?? models[0];
    if (!model) return loadout;
    const effort =
      model.defaultEffort && model.efforts.includes(model.defaultEffort)
        ? model.defaultEffort
        : model.efforts[0];
    return { ...loadout, model: model.id, ...(effort ? { effort } : {}) };
  }

  private validateLoadout(loadout: Loadout) {
    const models = this.registry.state(loadout.harness).models;
    if (!models.length) return;
    const model = models.find((model) => model.id === loadout.model);
    if (!model)
      throw new Error(
        `${loadout.model || "The selected model"} is not offered by ${HARNESS_LABELS[loadout.harness]} right now. Choose a model again.`,
      );
    if (
      loadout.effort &&
      model.efforts.length &&
      !model.efforts.includes(loadout.effort)
    )
      throw new Error(
        `${model.name} does not support ${loadout.effort} effort.`,
      );
  }

  async handle(command: TabCommand): Promise<TranscriptPage | undefined> {
    if (this.closed) throw new Error("The supervisor is shutting down.");
    switch (command.type) {
      case "tab.open":
        return this.open(command.roomId, command.harness, command.title);
      case "tab.rename":
        this.store.transaction((draft) => {
          const { tab } = findTab(draft, command.roomId, command.tabId);
          tab.title = command.title;
          tab.updatedAt = now();
        });
        return;
      case "tab.close":
        return this.closeTab(
          command.roomId,
          command.tabId,
          command.confirm === true,
        );
      case "tab.setLoadout":
        return this.setLoadout(command.roomId, command.tabId, command.loadout);
      case "tab.send":
        return this.send(command);
      case "tab.stop": {
        findTab(this.store.read(), command.roomId, command.tabId);
        const turn = this.live.get(command.tabId)?.turn;
        if ((!turn || turn.finished) && !this.runningAgents(command.tabId))
          throw new Error("This tab has no running turn.");
        this.stop(command.roomId, command.tabId);
        return;
      }
      case "tab.transcript":
        findTab(this.store.read(), command.roomId, command.tabId);
        this.writer.flush();
        return this.store.transcriptPage(
          command.tabId,
          command.beforeSeq,
          command.limit,
          command.agentKey,
        );
      case "tab.agents":
        findTab(this.store.read(), command.roomId, command.tabId);
        this.writer.flush();
        return {
          tabId: command.tabId,
          entries: this.store.agentCards(command.tabId),
          nextSeq: null,
        };
      case "tab.resetSession":
        return this.resetSession(command.roomId, command.tabId);
      case "approval.respond":
        return this.respond(
          command.roomId,
          command.tabId!,
          command.approvalId,
          command.decision,
        );
      case "question.answer":
        return this.answer(
          command.roomId,
          command.tabId,
          command.questionId,
          command.answers,
        );
    }
  }

  private open(
    roomId: string,
    harness: Tab["loadout"]["harness"],
    title?: string,
  ) {
    this.registry.adapter(harness);
    this.store.transaction((draft) => {
      const room = draft.rooms.find((room) => room.id === roomId);
      if (!room) throw new Error("Room not found on this desktop.");
      if (room.tabs.length >= 20)
        throw new Error("Close a tab before opening another.");
      const count = room.tabs.filter(
        (tab) => tab.loadout.harness === harness,
      ).length;
      const tab: Tab = {
        id: randomUUID(),
        roomId,
        title: title ?? `${HARNESS_LABELS[harness]} ${count + 1}`,
        loadout: this.withDefaultModel(DEFAULT_LOADOUT(harness)),
        status: this.registry.ready(harness) ? "idle" : "unavailable",
        readAlong: false,
        createdAt: now(),
        updatedAt: now(),
      };
      room.tabs.push(tab);
    });
    const state = this.registry.state(harness);
    if (
      state.auth.state === "unknown" ||
      !["ready", "custom"].includes(state.program.state)
    )
      void this.registry.refresh(harness);
    return undefined;
  }

  private closeTab(roomId: string, tabId: string, confirm: boolean) {
    const { tab } = findTab(this.store.read(), roomId, tabId);
    const live = this.live.get(tabId);
    if (tabBusy(tab.status) && !confirm)
      throw new Error(
        "This tab is running a turn. Confirm to stop it and close the tab.",
      );
    if (this.runningAgents(tabId) && !confirm)
      throw new Error(
        "This tab has running sub-agents. Confirm to stop them and close the tab.",
      );
    if ((live?.turn && !live.turn.finished) || this.runningAgents(tabId))
      this.stop(roomId, tabId);
    this.store.transaction((draft) => {
      const room = draft.rooms.find((room) => room.id === roomId)!;
      room.tabs = room.tabs.filter((item) => item.id !== tabId);
    });
    this.writer.forget(tabId);
    this.store.deleteTranscript(tabId);
    this.live.delete(tabId);
    clearTimeout(live?.stopTimer);
    live?.session?.close();
    return undefined;
  }

  private setLoadout(roomId: string, tabId: string, loadout: Loadout) {
    const { tab } = findTab(this.store.read(), roomId, tabId);
    if (tabBusy(tab.status))
      throw new Error("Change the loadout after this turn ends.");
    const harnessChanged = loadout.harness !== tab.loadout.harness;
    if (harnessChanged && this.runningAgents(tabId))
      throw new Error(
        "This tab's sub-agents are still running. Wait for them or stop them before switching harness.",
      );
    this.registry.adapter(loadout.harness);
    if (loadout.model) this.validateLoadout(loadout);
    if (harnessChanged) this.dropSession(roomId, tabId);
    this.store.transaction((draft) => {
      const { tab } = findTab(draft, roomId, tabId);
      tab.loadout = loadout.model ? loadout : this.withDefaultModel(loadout);
      if (harnessChanged) {
        delete tab.sessionId;
        delete tab.resumed;
        delete tab.plan;
        tab.status = this.registry.ready(loadout.harness)
          ? "idle"
          : "unavailable";
      }
      tab.updatedAt = now();
    });
    if (harnessChanged) {
      this.writer.append(roomId, tabId, {
        turnId: null,
        kind: "notice",
        notice: "harness_changed",
        summary: `Switched to ${HARNESS_LABELS[loadout.harness]}. The next turn starts a new session.`,
      });
      this.writer.release(tabId);
      const state = this.registry.state(loadout.harness);
      if (state.auth.state === "unknown")
        void this.registry.refresh(loadout.harness);
    }
    return undefined;
  }

  /**
   * Closes the tab's harness session. Its sub-agents cannot finish any more, so running cards
   * settle and their requests are cancelled.
   */
  private dropSession(
    roomId: string,
    tabId: string,
    outcome: "stopped" | "interrupted" = "interrupted",
  ) {
    const live = this.live.get(tabId);
    if (!live) return;
    // Cleared first so the closing session's last events are ignored.
    const session = live.session;
    live.session = undefined;
    session?.close();
    clearTimeout(live.stopTimer);
    live.stopTimer = undefined;
    for (const [entryId, request] of live.requests)
      if (request.agentKey) {
        this.writer.update(entryId, { state: "cancelled" });
        live.requests.delete(entryId);
      }
    for (const { entryId } of live.cards.values()) {
      const agent = this.writer.entry(entryId)?.agent;
      if (agent?.status === "running") this.endCard(entryId, agent, outcome);
    }
    live.cards.clear();
    this.counts(roomId, tabId);
  }

  private resetSession(roomId: string, tabId: string) {
    const { tab } = findTab(this.store.read(), roomId, tabId);
    if (tabBusy(tab.status)) throw new Error("Stop the running turn first.");
    if (this.runningAgents(tabId))
      throw new Error(
        "This tab's sub-agents are still running. Wait for them or stop them first.",
      );
    this.dropSession(roomId, tabId);
    this.store.transaction((draft) => {
      const { tab } = findTab(draft, roomId, tabId);
      delete tab.sessionId;
      delete tab.resumed;
      delete tab.plan;
      tab.status = this.ready(tab) ? "idle" : "unavailable";
      tab.updatedAt = now();
    });
    this.writer.append(roomId, tabId, {
      turnId: null,
      kind: "notice",
      notice: "session_reset",
      summary:
        "Started a fresh session. The harness no longer sees the earlier conversation.",
    });
    this.writer.release(tabId);
    return undefined;
  }

  private send(command: Extract<TabCommand, { type: "tab.send" }>) {
    const { room, tab } = findTab(
      this.store.read(),
      command.roomId,
      command.tabId,
    );
    if (tabBusy(tab.status) || this.live.get(tab.id)?.turn)
      throw new Error(
        "This tab is already running a turn. Wait for it or stop it.",
      );
    if (tab.status === "resume_failed")
      throw new Error(
        "This tab's session could not be resumed. Start a fresh session to continue.",
      );
    const label = HARNESS_LABELS[tab.loadout.harness];
    if (!this.ready(tab))
      throw new Error(
        `${label} is not ready. Open Harness settings to finish setup.`,
      );
    if (!tab.loadout.model) throw new Error(`Choose a ${label} model first.`);
    this.validateLoadout(tab.loadout);
    if (!room.workspace || !this.store.workspacePath(room.id))
      throw new Error("Select a local Git repository before sending.");
    const suggestion = command.suggestionId
      ? room.suggestions.find((item) => item.id === command.suggestionId)
      : undefined;
    if (command.suggestionId) {
      if (!suggestion) throw new Error("Suggestion not found in this room.");
      if (suggestion.revision !== command.suggestionRevision)
        throw new Error(
          "This suggestion changed. Use its latest version before sending.",
        );
      if (suggestion.status === "submitted")
        throw new Error("This suggestion was already submitted.");
    }
    const turn: Turn = {
      id: randomUUID(),
      roomId: room.id,
      harness: false,
      stopping: false,
      finished: false,
    };
    let loadout = tab.loadout;
    this.store.transaction((draft) => {
      const { room, tab } = findTab(draft, command.roomId, command.tabId);
      if (command.continuePlan)
        tab.loadout = { ...tab.loadout, planMode: false };
      loadout = tab.loadout;
      tab.status = "running";
      tab.updatedAt = now();
      const stored =
        suggestion &&
        room.suggestions.find((item) => item.id === suggestion.id);
      if (stored && !room.shared) {
        stored.status = "submitted";
        stored.updatedAt = now();
      }
    });
    this.writer.append(room.id, tab.id, {
      turnId: turn.id,
      kind: "user",
      summary: command.text,
      ...(suggestion
        ? {
            source: {
              suggestionId: suggestion.id,
              revision: suggestion.revision,
              prompt: suggestion.prompt,
              sources: structuredClone(suggestion.sources),
            },
          }
        : {}),
    });
    this.liveOf(tab.id).turn = turn;
    void this.run(tab.id, turn, command.text, loadout);
    return undefined;
  }

  private exists(roomId: string, tabId: string) {
    return this.store
      .read()
      .rooms.some(
        (room) =>
          room.id === roomId && room.tabs.some((tab) => tab.id === tabId),
      );
  }

  private async run(
    tabId: string,
    turn: Turn,
    prompt: string,
    loadout: Loadout,
  ) {
    const live = this.live.get(tabId)!;
    try {
      const context = await this.registry.context(loadout.harness);
      if (turn.stopping) return this.finish(tabId, turn, "stopped");
      if (!live.session) {
        const { tab } = findTab(this.store.read(), turn.roomId, tabId);
        const cwd = this.store.workspacePath(turn.roomId);
        if (!cwd)
          throw new HarnessError(
            "failed",
            "Select the repository again to restore access.",
          );
        const opened: { session?: HarnessSession } = {};
        const session = await this.registry.adapter(loadout.harness).open({
          ...context,
          tabId,
          cwd,
          loadout,
          ...(tab.sessionId ? { sessionId: tab.sessionId } : {}),
          // Events from a session the tab has since dropped are ignored.
          listener: (event) => {
            if (
              !opened.session ||
              this.live.get(tabId)?.session === opened.session
            )
              this.sessionEvent(turn.roomId, tabId, event);
          },
        });
        opened.session = session;
        if (turn.finished || !this.exists(turn.roomId, tabId)) {
          session.close();
          return;
        }
        live.session = session;
        if (tab.sessionId)
          this.store.transaction((draft) => {
            findTab(draft, turn.roomId, tabId).tab.resumed = true;
          });
      }
      if (turn.stopping) return this.finish(tabId, turn, "stopped");
      for await (const event of live.session.send(prompt, loadout)) {
        if (turn.finished) break;
        this.event(turn.roomId, tabId, turn, event);
      }
      this.finish(tabId, turn, turn.stopping ? "stopped" : "completed");
    } catch (error) {
      if (
        turn.stopping &&
        !(error instanceof HarnessError && error.kind === "signed_out")
      )
        this.finish(tabId, turn, "stopped");
      else this.fail(tabId, turn, error);
    }
  }

  /** Events a session reports outside the owner's turn iterator. */
  private sessionEvent(roomId: string, tabId: string, event: SessionEvent) {
    if (this.closed || !this.exists(roomId, tabId)) return;
    const live = this.liveOf(tabId);
    const turn = live.turn && !live.turn.finished ? live.turn : undefined;
    switch (event.type) {
      case "turn.started": {
        if (turn) return;
        live.turn = {
          id: randomUUID(),
          roomId,
          harness: true,
          stopping: false,
          finished: false,
        };
        this.setStatus(roomId, tabId, "running");
        return;
      }
      case "turn.completed":
        if (turn?.harness)
          this.finish(tabId, turn, turn.stopping ? "stopped" : "completed");
        return;
      case "turn.failed":
        if (!turn?.harness) return;
        if (turn.stopping && event.error.kind !== "signed_out")
          this.finish(tabId, turn, "stopped");
        else this.fail(tabId, turn, event.error);
        return;
      case "crashed": {
        const failure = new HarnessError("crashed", event.message);
        if (turn?.harness) return this.fail(tabId, turn, failure);
        // An owner turn reports the failure through its own iterator.
        if (turn) return;
        const running = this.runningAgents(tabId);
        this.dropSession(roomId, tabId);
        if (running)
          this.writer.append(roomId, tabId, {
            turnId: null,
            kind: "notice",
            summary: `${event.message} Its running sub-agents were interrupted.`,
          });
        this.writer.release(tabId);
        return;
      }
      default:
        this.event(roomId, tabId, turn, event);
        if (!turn) this.writer.release(tabId);
    }
  }

  /** The turn a sub-agent's entries file under: its card's, else the running turn. */
  private filing(tabId: string, turn: Turn | undefined, agentKey?: string) {
    const card = agentKey
      ? this.live.get(tabId)?.cards.get(agentKey)
      : undefined;
    return card ? card.turnId : (turn?.id ?? null);
  }

  private event(
    roomId: string,
    tabId: string,
    turn: Turn | undefined,
    event: HarnessEvent,
  ) {
    if (!this.exists(roomId, tabId)) return;
    const live = this.liveOf(tabId);
    switch (event.type) {
      case "session":
        this.store.transaction((draft) => {
          const { tab } = findTab(draft, roomId, tabId);
          tab.sessionId = event.sessionId;
        });
        return;
      case "text":
      case "message":
        return this.writer.text(
          roomId,
          tabId,
          this.filing(tabId, turn, event.agent),
          event.item,
          event.kind,
          event.type === "text" ? event.delta : event.text,
          event.type === "message",
          event.agent,
        );
      case "tool": {
        const created = this.writer.tool(
          roomId,
          tabId,
          this.filing(tabId, turn, event.agent),
          event.item,
          event.summary,
          event.detail,
          event.agent,
        );
        const card = event.agent ? live.cards.get(event.agent) : undefined;
        const agent = card && this.writer.entry(card.entryId)?.agent;
        if (created && card && agent?.status === "running")
          this.writer.update(card.entryId, {
            agent: {
              ...agent,
              toolUses: agent.toolUses + 1,
              latestTool: oneLine(event.summary, 200),
            },
          });
        return;
      }
      case "notice":
        this.writer.append(roomId, tabId, {
          turnId: this.filing(tabId, turn, event.agent),
          kind: "notice",
          summary: event.summary,
          ...(event.notice ? { notice: event.notice } : {}),
          ...(event.agent ? { agentKey: event.agent } : {}),
        });
        return;
      case "agent":
        return this.agent(roomId, tabId, turn, event);
      case "steps":
        this.store.transaction((draft) => {
          const { tab } = findTab(draft, roomId, tabId);
          tab.plan = {
            turnId: turn?.id ?? null,
            steps: event.steps,
            ...(event.explanation ? { explanation: event.explanation } : {}),
            updatedAt: now(),
          };
        });
        return;
      case "approval":
      case "question": {
        const turnId = this.filing(tabId, turn, event.agent);
        const agentKey = event.agent ? { agentKey: event.agent } : {};
        const entry =
          event.type === "approval"
            ? this.writer.append(roomId, tabId, {
                turnId,
                kind: event.plan ? "plan" : "approval",
                state: "pending",
                summary: event.summary,
                ...(event.detail ? { detail: event.detail } : {}),
                ...agentKey,
              })
            : this.writer.append(roomId, tabId, {
                turnId,
                kind: "question",
                state: "pending",
                summary: event.questions
                  .map((question) => question.question)
                  .join(" "),
                questions: event.questions,
                ...agentKey,
              });
        live.requests.set(entry.id, { request: event.request, ...agentKey });
        this.writer.flush();
        // Only the lead's own requests hold its turn.
        if (event.agent) this.counts(roomId, tabId);
        else if (turn) this.setStatus(roomId, tabId, "awaiting_host");
        return;
      }
    }
  }

  /** Creates or updates a sub-agent card. */
  private agent(
    roomId: string,
    tabId: string,
    turn: Turn | undefined,
    event: AgentEvent,
  ) {
    const live = this.liveOf(tabId);
    const known = live.cards.get(event.key);
    const entry = known && this.cardEntry(roomId, tabId, known.entryId);
    const fields: Partial<AgentCard> = {
      ...(event.agentType !== undefined ? { type: event.agentType } : {}),
      ...(event.name !== undefined ? { name: event.name } : {}),
      ...(event.model !== undefined ? { model: event.model } : {}),
      ...(event.background !== undefined
        ? { background: event.background }
        : {}),
      ...(event.toolUses !== undefined ? { toolUses: event.toolUses } : {}),
      ...(event.latestTool !== undefined
        ? { latestTool: oneLine(event.latestTool, 200) }
        : {}),
    };
    if (!known || !entry?.agent) {
      const parent = event.parentKey
        ? live.cards.get(event.parentKey)
        : undefined;
      const turnId = turn?.id ?? parent?.turnId ?? null;
      const created = this.writer.append(roomId, tabId, {
        turnId,
        kind: "agent",
        summary: oneLine(event.description ?? "Sub-agent", 2_000),
        agent: {
          key: event.key,
          ...(event.parentKey ? { parentKey: event.parentKey } : {}),
          status: "running",
          background: false,
          startedAt: now(),
          toolUses: 0,
          ...fields,
        },
      });
      live.cards.set(event.key, { entryId: created.id, turnId });
      if (event.status && event.status !== "running")
        this.endCard(created.id, created.agent!, event.status, event.summary);
    } else {
      const agent = { ...entry.agent, ...fields };
      const status = event.status ?? agent.status;
      const patch = {
        ...(event.description
          ? { summary: oneLine(event.description, 2_000) }
          : {}),
      };
      if (status === "running" && agent.status !== "running") {
        // Re-engaged: new entries file under the turn that re-engaged it.
        known.turnId = turn?.id ?? known.turnId;
        delete agent.endedAt;
        this.writer.update(entry.id, {
          ...patch,
          agent: { ...agent, status },
        });
      } else if (status !== "running" && agent.status === "running") {
        this.writer.update(entry.id, { ...patch, agent });
        this.endCard(entry.id, agent, status, event.summary);
      } else
        this.writer.update(entry.id, {
          ...patch,
          ...(event.summary !== undefined ? { detail: event.summary } : {}),
          agent: { ...agent, status },
        });
    }
    const status = this.writer.entry(live.cards.get(event.key)!.entryId)?.agent
      ?.status;
    if (status !== "running")
      for (const [entryId, request] of live.requests)
        if (request.agentKey === event.key) {
          this.writer.update(entryId, { state: "cancelled" });
          live.requests.delete(entryId);
        }
    this.counts(roomId, tabId);
  }

  /** A card entry, reloaded from the journal when the writer already released it. */
  private cardEntry(roomId: string, tabId: string, entryId: string) {
    const entry = this.writer.entry(entryId);
    if (entry) return entry;
    const stored = this.store
      .agentCards(tabId)
      .find((item) => item.id === entryId);
    if (!stored) return undefined;
    this.writer.adopt(roomId, stored);
    return this.writer.entry(entryId);
  }

  /** Settles a running card; stopped and interrupted cards get a note in place of a summary. */
  private endCard(
    entryId: string,
    agent: AgentCard,
    status: Exclude<AgentCard["status"], "running">,
    summary?: string,
  ) {
    const detail =
      summary ??
      (status === "stopped" || status === "interrupted"
        ? NOTES[status]
        : undefined);
    this.writer.update(entryId, {
      agent: { ...agent, status, endedAt: now() },
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  private runningAgents(tabId: string) {
    const live = this.live.get(tabId);
    if (!live) return 0;
    return [...live.cards.values()].filter(
      (card) => this.writer.entry(card.entryId)?.agent?.status === "running",
    ).length;
  }

  /** Mirrors running sub-agents and their waiting requests onto the tab. */
  private counts(roomId: string, tabId: string) {
    if (!this.exists(roomId, tabId)) return;
    const live = this.live.get(tabId);
    const running = this.runningAgents(tabId);
    const waiting = live
      ? [...live.requests.values()].filter((request) => request.agentKey).length
      : 0;
    if (live && !running) {
      clearTimeout(live.stopTimer);
      live.stopTimer = undefined;
    }
    const { tab } = findTab(this.store.read(), roomId, tabId);
    if (
      (tab.runningAgents ?? 0) === running &&
      (tab.agentRequests ?? 0) === waiting
    )
      return;
    this.store.transaction((draft) => {
      const { tab } = findTab(draft, roomId, tabId);
      if (running) tab.runningAgents = running;
      else delete tab.runningAgents;
      if (waiting) tab.agentRequests = waiting;
      else delete tab.agentRequests;
      tab.updatedAt = now();
    });
  }

  private setStatus(roomId: string, tabId: string, status: Tab["status"]) {
    if (!this.exists(roomId, tabId)) return;
    this.store.transaction((draft) => {
      const { tab } = findTab(draft, roomId, tabId);
      tab.status = status;
      tab.updatedAt = now();
    });
  }

  private pendingEntry(roomId: string, tabId: string, entryId: string) {
    findTab(this.store.read(), roomId, tabId);
    const live = this.live.get(tabId);
    const entry = this.writer.entry(entryId);
    const request = live?.requests.get(entryId);
    if (
      !live?.session ||
      !entry ||
      entry.tabId !== tabId ||
      entry.state !== "pending" ||
      !request
    )
      throw new Error("That request is no longer pending.");
    return { live, entry, request: request.request, session: live.session };
  }

  private settle(roomId: string, tabId: string, live: Live, entryId: string) {
    const request = live.requests.get(entryId);
    live.requests.delete(entryId);
    this.writer.flush();
    if (request?.agentKey) return this.counts(roomId, tabId);
    const turn = live.turn;
    if (
      turn &&
      !turn.finished &&
      !turn.stopping &&
      ![...live.requests.values()].some((request) => !request.agentKey)
    )
      this.setStatus(roomId, tabId, "running");
  }

  private respond(
    roomId: string,
    tabId: string,
    entryId: string,
    decision: "accept" | "decline",
  ) {
    const { live, entry, request, session } = this.pendingEntry(
      roomId,
      tabId,
      entryId,
    );
    session.respond(request, decision);
    this.writer.update(entry.id, {
      state: decision === "accept" ? "accepted" : "declined",
    });
    if (entry.kind === "plan" && !entry.agentKey && decision === "accept")
      this.store.transaction((draft) => {
        const { tab } = findTab(draft, roomId, tabId);
        tab.loadout = { ...tab.loadout, planMode: false };
      });
    this.settle(roomId, tabId, live, entryId);
    return undefined;
  }

  private answer(
    roomId: string,
    tabId: string,
    entryId: string,
    answers: Record<string, string[]>,
  ) {
    const { live, entry, request, session } = this.pendingEntry(
      roomId,
      tabId,
      entryId,
    );
    const known = new Set(entry.questions?.map((question) => question.id));
    if (Object.keys(answers).some((id) => !known.has(id)))
      throw new Error("Those answers do not match the question.");
    session.answer(request, answers);
    const secret = new Set(
      entry.questions
        ?.filter((question) => question.secret)
        .map((question) => question.id),
    );
    this.writer.update(entry.id, {
      state: "answered",
      detail: Object.entries(answers)
        .map(
          ([id, values]) =>
            `${id}: ${secret.has(id) ? "(hidden)" : values.join(", ")}`,
        )
        .join("\n"),
    });
    this.settle(roomId, tabId, live, entryId);
    return undefined;
  }

  /** Stops the running turn and every running sub-agent. */
  private stop(roomId: string, tabId: string) {
    const live = this.liveOf(tabId);
    const turn = live.turn && !live.turn.finished ? live.turn : undefined;
    if (turn ? turn.stopping : live.stopTimer) return;
    if (turn) turn.stopping = true;
    for (const entryId of live.requests.keys())
      this.writer.update(entryId, { state: "cancelled" });
    live.requests.clear();
    this.writer.flush();
    this.counts(roomId, tabId);
    void live.session?.stop().catch(() => {});
    // A harness that ignores the interrupt is closed so the tab never stays stuck.
    const timer = setTimeout(() => {
      if (live.turn && live.turn !== turn) return;
      if (turn && !turn.finished) {
        this.dropSession(roomId, tabId, "stopped");
        this.finish(tabId, turn, "stopped");
      } else if (this.runningAgents(tabId)) {
        this.dropSession(roomId, tabId, "stopped");
        this.writer.release(tabId);
      }
    }, this.stopTimeoutMs);
    timer.unref?.();
    if (turn) turn.stopTimer = timer;
    else live.stopTimer = timer;
  }

  private finish(tabId: string, turn: Turn, outcome: "completed" | "stopped") {
    if (turn.finished) return;
    this.end(tabId, turn);
    if (!this.exists(turn.roomId, tabId)) return;
    const { tab } = findTab(this.store.read(), turn.roomId, tabId);
    const entries = this.writer.turnEntries(tabId, turn.id);
    if (outcome === "completed" && tab.loadout.planMode) {
      const plan = entries
        .filter(
          (entry) => entry.kind === "plan" && !entry.state && !entry.agentKey,
        )
        .at(-1);
      if (plan) this.writer.update(plan.id, { continuable: true });
    }
    this.writer.append(turn.roomId, tabId, {
      turnId: turn.id,
      kind: "turn",
      outcome,
      summary:
        outcome === "completed"
          ? "Turn completed."
          : "Turn stopped by the host.",
    });
    this.writer.release(tabId);
    this.store.transaction((draft) => {
      const { tab } = findTab(draft, turn.roomId, tabId);
      tab.status = this.ready(tab) ? "idle" : "unavailable";
      if (outcome === "completed") delete tab.resumed;
      tab.updatedAt = now();
    });
  }

  private fail(tabId: string, turn: Turn, error: unknown) {
    if (turn.finished) return;
    this.end(tabId, turn);
    if (!this.exists(turn.roomId, tabId)) return;
    const { tab } = findTab(this.store.read(), turn.roomId, tabId);
    const failure =
      error instanceof HarnessError
        ? error
        : new HarnessError(
            "failed",
            error instanceof Error ? error.message : "The harness failed.",
          );
    const roomId = turn.roomId;
    let status: Tab["status"] = "error";
    if (failure.kind === "signed_out") {
      this.registry.markSignedOut(tab.loadout.harness, failure.message);
      this.writer.append(roomId, tabId, {
        turnId: turn.id,
        kind: "notice",
        notice: "signed_out",
        summary: `${HARNESS_LABELS[tab.loadout.harness]} is signed out. Sign in again from Harness settings, then send a follow-up.`,
      });
      status = "unavailable";
    } else if (failure.kind === "resume_failed") {
      this.dropSession(roomId, tabId);
      this.writer.append(roomId, tabId, {
        turnId: turn.id,
        kind: "notice",
        notice: "resume_failed",
        offerFreshSession: true,
        summary: `${HARNESS_LABELS[tab.loadout.harness]} could not resume this tab's session. Start a fresh session in this tab to continue.`,
      });
      status = "resume_failed";
    } else {
      if (failure.kind === "crashed") this.dropSession(roomId, tabId);
      this.writer.append(roomId, tabId, {
        turnId: turn.id,
        kind: "error",
        summary: failure.message,
        ...(failure.kind === "usage_limit"
          ? { notice: "usage_limit" as const, resetsAt: failure.resetsAt }
          : {}),
        ...(tab.resumed ? { offerFreshSession: true } : {}),
      });
      if (failure.kind === "unavailable") status = "unavailable";
    }
    this.writer.append(roomId, tabId, {
      turnId: turn.id,
      kind: "turn",
      outcome: "failed",
      summary: "Turn failed.",
    });
    this.writer.release(tabId);
    this.store.transaction((draft) => {
      const { tab } = findTab(draft, roomId, tabId);
      tab.status = status;
      tab.updatedAt = now();
    });
  }

  /** Ends a turn; only the lead's requests go with it. */
  private end(tabId: string, turn: Turn) {
    turn.finished = true;
    clearTimeout(turn.stopTimer);
    const live = this.live.get(tabId);
    if (!live) return;
    for (const [entryId, request] of live.requests)
      if (!request.agentKey) {
        this.writer.update(entryId, { state: "cancelled" });
        live.requests.delete(entryId);
      }
    if (live.turn === turn) live.turn = undefined;
  }

  close() {
    this.closed = true;
    for (const live of this.live.values()) {
      if (live.turn) live.turn.finished = true;
      clearTimeout(live.stopTimer);
      live.session?.close();
    }
    this.live.clear();
    this.writer.close();
  }
}
