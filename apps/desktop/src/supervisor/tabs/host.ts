import { randomUUID } from "node:crypto";
import type { Command, Room, Snapshot } from "../../shared/contracts";
import {
  DEFAULT_LOADOUT,
  HARNESS_LABELS,
  tabBusy,
  type Loadout,
  type Tab,
  type TranscriptEntry,
  type TranscriptPage,
} from "../../shared/tabs";
import {
  HarnessError,
  type HarnessEvent,
  type HarnessSession,
} from "../harnesses/contract";
import type { HarnessRegistry } from "../harnesses/registry";
import type { TranscriptWriter } from "./transcript";

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
  ): TranscriptPage;
  pendingEntries(tabId: string): TranscriptEntry[];
  deleteTranscript(tabId: string): void;
}

interface Turn {
  id: string;
  roomId: string;
  // Transcript entry ID -> the harness's request ID, for approvals and questions still pending.
  requests: Map<string, string>;
  stopping: boolean;
  finished: boolean;
  aborted: boolean;
  stopTimer?: ReturnType<typeof setTimeout>;
}
interface Live {
  session?: HarnessSession;
  turn?: Turn;
}

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

  /** After an app restart, running turns are interrupted and pending requests are cleared. */
  recover() {
    const interrupted: { roomId: string; tabId: string }[] = [];
    this.store.transaction((draft) => {
      for (const room of draft.rooms)
        for (const tab of room.tabs)
          if (tabBusy(tab.status)) {
            tab.status = "interrupted";
            tab.updatedAt = now();
            interrupted.push({ roomId: room.id, tabId: tab.id });
          }
    });
    for (const { roomId, tabId } of interrupted) {
      for (const entry of this.store.pendingEntries(tabId)) {
        this.writer.adopt(roomId, entry);
        this.writer.update(entry.id, { state: "cancelled" });
      }
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
        const turn = this.live.get(command.tabId)?.turn;
        findTab(this.store.read(), command.roomId, command.tabId);
        if (!turn || turn.finished)
          throw new Error("This tab has no running turn.");
        this.stop(command.tabId, turn);
        return;
      }
      case "tab.transcript":
        findTab(this.store.read(), command.roomId, command.tabId);
        this.writer.flush();
        return this.store.transcriptPage(
          command.tabId,
          command.beforeSeq,
          command.limit,
        );
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
    if (live?.turn && !live.turn.finished) this.stop(tabId, live.turn);
    this.store.transaction((draft) => {
      const room = draft.rooms.find((room) => room.id === roomId)!;
      room.tabs = room.tabs.filter((item) => item.id !== tabId);
    });
    this.writer.forget(tabId);
    this.store.deleteTranscript(tabId);
    this.live.delete(tabId);
    live?.session?.close();
    return undefined;
  }

  private setLoadout(roomId: string, tabId: string, loadout: Loadout) {
    const { tab } = findTab(this.store.read(), roomId, tabId);
    if (tabBusy(tab.status))
      throw new Error("Change the loadout after this turn ends.");
    this.registry.adapter(loadout.harness);
    if (loadout.model) this.validateLoadout(loadout);
    const harnessChanged = loadout.harness !== tab.loadout.harness;
    if (harnessChanged) this.dropSession(tabId);
    this.store.transaction((draft) => {
      const { tab } = findTab(draft, roomId, tabId);
      tab.loadout = loadout.model ? loadout : this.withDefaultModel(loadout);
      if (harnessChanged) {
        delete tab.sessionId;
        delete tab.resumed;
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

  private dropSession(tabId: string) {
    const live = this.live.get(tabId);
    live?.session?.close();
    if (live) live.session = undefined;
  }

  private resetSession(roomId: string, tabId: string) {
    const { tab } = findTab(this.store.read(), roomId, tabId);
    if (tabBusy(tab.status)) throw new Error("Stop the running turn first.");
    this.dropSession(tabId);
    this.store.transaction((draft) => {
      const { tab } = findTab(draft, roomId, tabId);
      delete tab.sessionId;
      delete tab.resumed;
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
      requests: new Map(),
      stopping: false,
      finished: false,
      aborted: false,
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
    const live = this.live.get(tab.id) ?? {};
    live.turn = turn;
    this.live.set(tab.id, live);
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
        const session = await this.registry.adapter(loadout.harness).open({
          ...context,
          tabId,
          cwd,
          loadout,
          ...(tab.sessionId ? { sessionId: tab.sessionId } : {}),
        });
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
        this.event(tabId, turn, event);
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

  private event(tabId: string, turn: Turn, event: HarnessEvent) {
    if (!this.exists(turn.roomId, tabId)) return;
    const roomId = turn.roomId;
    switch (event.type) {
      case "session":
        this.store.transaction((draft) => {
          const { tab } = findTab(draft, roomId, tabId);
          tab.sessionId = event.sessionId;
        });
        return;
      case "text":
        return this.writer.text(
          roomId,
          tabId,
          turn.id,
          event.item,
          event.kind,
          event.delta,
        );
      case "message":
        return this.writer.text(
          roomId,
          tabId,
          turn.id,
          event.item,
          event.kind,
          event.text,
          true,
        );
      case "tool":
        return this.writer.tool(
          roomId,
          tabId,
          turn.id,
          event.item,
          event.summary,
          event.detail,
        );
      case "notice":
        this.writer.append(roomId, tabId, {
          turnId: turn.id,
          kind: "notice",
          summary: event.summary,
          ...(event.notice ? { notice: event.notice } : {}),
        });
        return;
      case "approval":
      case "question": {
        const entry =
          event.type === "approval"
            ? this.writer.append(roomId, tabId, {
                turnId: turn.id,
                kind: event.plan ? "plan" : "approval",
                state: "pending",
                summary: event.summary,
                ...(event.detail ? { detail: event.detail } : {}),
              })
            : this.writer.append(roomId, tabId, {
                turnId: turn.id,
                kind: "question",
                state: "pending",
                summary: event.questions
                  .map((question) => question.question)
                  .join(" "),
                questions: event.questions,
              });
        turn.requests.set(entry.id, event.request);
        this.writer.flush();
        this.setStatus(roomId, tabId, "awaiting_host");
        return;
      }
    }
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
    const turn = this.live.get(tabId)?.turn;
    const entry = this.writer.entry(entryId);
    const request = turn?.requests.get(entryId);
    if (
      !turn ||
      turn.finished ||
      !entry ||
      entry.tabId !== tabId ||
      entry.state !== "pending" ||
      !request
    )
      throw new Error("That request is no longer pending.");
    return { turn, entry, request, session: this.live.get(tabId)!.session! };
  }

  private settle(tabId: string, turn: Turn, entryId: string) {
    turn.requests.delete(entryId);
    this.writer.flush();
    if (!turn.requests.size && !turn.stopping)
      this.setStatus(turn.roomId, tabId, "running");
  }

  private respond(
    roomId: string,
    tabId: string,
    entryId: string,
    decision: "accept" | "decline",
  ) {
    const { turn, entry, request, session } = this.pendingEntry(
      roomId,
      tabId,
      entryId,
    );
    session.respond(request, decision);
    this.writer.update(entry.id, {
      state: decision === "accept" ? "accepted" : "declined",
    });
    if (entry.kind === "plan" && decision === "accept")
      this.store.transaction((draft) => {
        const { tab } = findTab(draft, roomId, tabId);
        tab.loadout = { ...tab.loadout, planMode: false };
      });
    this.settle(tabId, turn, entryId);
    return undefined;
  }

  private answer(
    roomId: string,
    tabId: string,
    entryId: string,
    answers: Record<string, string[]>,
  ) {
    const { turn, entry, request, session } = this.pendingEntry(
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
    this.settle(tabId, turn, entryId);
    return undefined;
  }

  private stop(tabId: string, turn: Turn) {
    if (turn.stopping) return;
    turn.stopping = true;
    for (const entryId of turn.requests.keys())
      this.writer.update(entryId, { state: "cancelled" });
    turn.requests.clear();
    this.writer.flush();
    const session = this.live.get(tabId)?.session;
    void session?.stop().catch(() => {});
    // A harness that ignores the interrupt is closed so the tab never stays stuck.
    turn.stopTimer = setTimeout(() => {
      if (turn.finished) return;
      this.dropSession(tabId);
      this.finish(tabId, turn, "stopped");
    }, this.stopTimeoutMs);
    turn.stopTimer.unref?.();
  }

  private finish(tabId: string, turn: Turn, outcome: "completed" | "stopped") {
    if (turn.finished) return;
    this.end(tabId, turn);
    if (!this.exists(turn.roomId, tabId)) return;
    const { tab } = findTab(this.store.read(), turn.roomId, tabId);
    const entries = this.writer.turnEntries(tabId, turn.id);
    if (outcome === "completed" && tab.loadout.planMode) {
      const plan = entries
        .filter((entry) => entry.kind === "plan" && !entry.state)
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
      this.dropSession(tabId);
      this.writer.append(roomId, tabId, {
        turnId: turn.id,
        kind: "notice",
        notice: "resume_failed",
        offerFreshSession: true,
        summary: `${HARNESS_LABELS[tab.loadout.harness]} could not resume this tab's session. Start a fresh session in this tab to continue.`,
      });
      status = "resume_failed";
    } else {
      if (failure.kind === "crashed") this.dropSession(tabId);
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

  private end(tabId: string, turn: Turn) {
    turn.finished = true;
    clearTimeout(turn.stopTimer);
    for (const entryId of turn.requests.keys())
      this.writer.update(entryId, { state: "cancelled" });
    turn.requests.clear();
    const live = this.live.get(tabId);
    if (live?.turn === turn) live.turn = undefined;
  }

  close() {
    this.closed = true;
    for (const live of this.live.values()) {
      if (live.turn) live.turn.finished = true;
      live.session?.close();
    }
    this.live.clear();
    this.writer.close();
  }
}
