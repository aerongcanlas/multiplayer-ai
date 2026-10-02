import type {
  ReadAlongStatus,
  SharedAgent,
  SharedPlan,
  SharedTabStatus,
} from "../shared/collaboration";
import type { Result, Snapshot, SupervisorRequest } from "../shared/contracts";
import { maskCredentials, publishablePrefix } from "../shared/masking";
import {
  inReadAlongWindow,
  type Tab,
  type TabPlan,
  type TranscriptBatch,
  type TranscriptEntry,
  type TranscriptPage,
} from "../shared/tabs";
import { oneLine } from "../supervisor/tabs/transcript";
import type { CollaborationClient } from "./collaboration-client";

const INTERVAL_MS = 1_000;
const MAX_ENTRIES = 200;
const MAX_BYTES = 1_000_000;
const MAX_TEXT = 200_000;
const MAX_DETAIL_BYTES = 65_000;
// The transcript writer keeps only an entry's last 200k characters, so past that its start moves.
const WRITER_CLAMP = 200_000;

// The whitelisted body a viewer receives for one entry.
export interface PublishedEntry {
  seq: number;
  kind: TranscriptEntry["kind"];
  share: "full" | "summary";
  summary: string;
  text?: string;
  detail?: string;
  state?: TranscriptEntry["state"];
  outcome?: TranscriptEntry["outcome"];
  notice?: TranscriptEntry["notice"];
  // Sub-agent cards only: summary is the task and text the final summary.
  agent?: SharedAgent;
  version: number;
}
type Body = Omit<PublishedEntry, "version">;
export interface PublishedRecord {
  tabId: string;
  roomId: string;
  deviceId: string;
  title: string;
  harness: Tab["loadout"]["harness"];
  model: string;
  status: SharedTabStatus;
  switchOn: boolean;
  // Sent only while read-along is on, so an ended record keeps what it last shared.
  plan?: SharedPlan | null;
  runningAgents?: number;
  // Null when the snapshot does not say whether the harness reports sub-agents.
  reportsAgents?: boolean | null;
}
// What a card showed when it joined mid-run; work from before the switch stays unpublished.
interface MidRun {
  latestTool?: string;
}
interface Head {
  maxSeq: number | null;
  version: number | null;
  rev: number;
  // Approvals stored as pending and sub-agent cards stored as running.
  pending?: { seq: number; version: number }[];
}

const FULL_KINDS = new Set(["user", "assistant", "plan"]);
const SUMMARY_KINDS = new Set(["tool", "approval", "error", "turn", "notice"]);
const STREAMING_KINDS = new Set(["assistant", "plan"]);
const MAX_PLAN_STEPS = 50;
const MAX_STEP = 300;
const MAX_EXPLANATION = 1_000;

const clampBytes = (text: string, limit: number) => {
  const bytes = Buffer.from(text);
  return bytes.length <= limit
    ? text
    : bytes.subarray(0, limit).toString().replace(/�+$/, "");
};

// Masked first, then cut, so a credential straddling the cut never leaks a prefix.
const maskedLine = (text: string, limit = 400) =>
  oneLine(maskCredentials(text), limit);

// A sub-agent card: its task, masked card fields, and its final summary once it has one.
function projectCard(entry: TranscriptEntry, midRun?: MidRun): Body | null {
  const card = entry.agent;
  if (!card) return null;
  const running = card.status === "running";
  // A summary still being written publishes only its safe prefix.
  const text = (
    running
      ? publishablePrefix(entry.detail ?? "")
      : maskCredentials(entry.detail ?? "")
  ).slice(0, MAX_TEXT);
  const latestTool =
    card.latestTool !== undefined && card.latestTool !== midRun?.latestTool
      ? maskedLine(card.latestTool)
      : "";
  return {
    seq: entry.seq,
    kind: "agent",
    share: "full",
    summary: maskedLine(entry.summary),
    ...(text.trim() ? { text } : {}),
    agent: {
      key: card.key.slice(0, 200),
      ...(card.parentKey ? { parentKey: card.parentKey.slice(0, 200) } : {}),
      ...(card.name ? { name: maskedLine(card.name, 200) } : {}),
      ...(card.type ? { type: maskedLine(card.type, 200) } : {}),
      status: card.status,
      background: card.background,
      startedAt: card.startedAt.slice(0, 64),
      ...(card.endedAt ? { endedAt: card.endedAt.slice(0, 64) } : {}),
      toolUses: card.toolUses,
      ...(latestTool ? { latestTool } : {}),
      ...(midRun ? { joinedMidRun: true } : {}),
      ...(entry.turnId ? { turnId: entry.turnId } : {}),
    },
  };
}

/** The tab's plan as viewers see it: masked, at most 50 steps of 300 characters. */
export function projectPlan(plan: TabPlan | undefined): SharedPlan | null {
  if (!plan?.steps.length) return null;
  const explanation = maskCredentials(plan.explanation ?? "")
    .slice(0, MAX_EXPLANATION)
    .trim();
  return {
    ...(explanation ? { explanation } : {}),
    steps: plan.steps.slice(0, MAX_PLAN_STEPS).map((step) => ({
      text: maskedLine(step.text, MAX_STEP),
      status: step.status,
    })),
  };
}

/**
 * Projects a transcript entry to what viewers may see: user and agent text in full, a sub-agent
 * as its card, everything else as one masked line, and nothing from reasoning, questions, a
 * sub-agent's own entries, or local detail except a plan's body. A streaming entry publishes
 * only its safe prefix until complete. `midRun` marks a card that joined mid-run.
 */
export function projectEntry(
  entry: TranscriptEntry,
  complete: boolean,
  midRun?: MidRun,
): Body | null {
  if (entry.share === "none") return null;
  if (entry.kind === "agent") return projectCard(entry, midRun);
  if (entry.agentKey && entry.kind !== "approval") return null;
  if (!FULL_KINDS.has(entry.kind) && !SUMMARY_KINDS.has(entry.kind))
    return null;
  const base = {
    seq: entry.seq,
    kind: entry.kind,
    ...(entry.state ? { state: entry.state } : {}),
    ...(entry.outcome ? { outcome: entry.outcome } : {}),
    ...(entry.notice ? { notice: entry.notice } : {}),
  };
  if (!FULL_KINDS.has(entry.kind))
    return {
      ...base,
      share: "summary",
      summary: oneLine(maskCredentials(entry.summary)),
    };
  const text = (
    STREAMING_KINDS.has(entry.kind) && !complete
      ? publishablePrefix(entry.summary)
      : maskCredentials(entry.summary)
  ).slice(0, MAX_TEXT);
  if (!text.trim() && !entry.state) return null;
  const firstLine = text.split("\n").find((line) => line.trim()) ?? "";
  return {
    ...base,
    share: "full",
    summary: oneLine(firstLine),
    text,
    ...(entry.kind === "plan" && entry.detail
      ? {
          detail: clampBytes(maskCredentials(entry.detail), MAX_DETAIL_BYTES),
        }
      : {}),
  };
}

/** The record status viewers see for a local tab. */
export function recordStatus(tab: Tab | undefined): SharedTabStatus {
  if (!tab) return "closed";
  if (!tab.readAlong) return "ended";
  if (tab.status === "awaiting_host" || (tab.agentRequests ?? 0) > 0)
    return "awaiting_host";
  if (tab.status === "running") return "running";
  if (tab.status === "idle") return "idle";
  return "interrupted";
}

interface Shared {
  roomId: string;
  tab: Tab;
  // Entries inside a window, latest local state by seq. Settled ones are dropped once published.
  raw: Map<number, TranscriptEntry>;
  // Per-entry version counters and the body last staged for each.
  versions: Map<number, { version: number; body?: string }>;
  staged: Map<number, PublishedEntry>;
  // Held entries whose projection may have changed since it was last staged.
  dirty: Set<number>;
  // Turns with a later entry or their turn marker, which complete earlier streaming entries.
  turnLast: Map<string, number>;
  ended: Set<string>;
  // Cards that joined mid-run, by key. Their entries sit before the window and still publish.
  midRun: Map<string, MidRun>;
  // The database predates sub-agent cards and refused one: cards stop publishing.
  noCards?: boolean;
  lastRecord?: string;
  seeded: boolean;
  inflight: boolean;
  timer?: ReturnType<typeof setTimeout>;
  stopped?: "not_member" | "migration_missing";
  // The tab closed: every held entry counts as complete for its last publish.
  closing?: boolean;
}

type Collaboration = Pick<
  CollaborationClient,
  "state" | "rooms" | "currentEpoch" | "readAlong" | "refresh"
>;

/**
 * Publishes read-along tabs to Supabase from main. Entries are tapped from validated transcript
 * batches, filtered by on-window membership, projected, masked, and coalesced to one publish per
 * second per tab. The server rows are the watermark: after a relaunch, reconnect, or sign-in the
 * publisher reconciles device rows and backfills each shared tab from the journal after its head.
 */
export class ReadAlongPublisher {
  private tabs = new Map<string, Shared>();
  private local?: Snapshot;
  private epoch = -1;
  private ready = false;
  private backfilling?: Promise<void>;
  private closed = false;
  private lastStatus = "{}";

  constructor(
    private collaboration: Collaboration,
    private supervisor: {
      request(command: SupervisorRequest["command"]): Promise<Result>;
    },
    private changed: () => void,
    private interval = INTERVAL_MS,
  ) {
    this.epoch = collaboration.currentEpoch;
  }

  // Tells the coordinator only when the status map changed.
  private notify() {
    const status = JSON.stringify(this.status());
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    this.changed();
  }

  /** Status for every tab that is sharing or was stopped, keyed by tab ID. */
  status(): Record<string, ReadAlongStatus> {
    const result: Record<string, ReadAlongStatus> = {};
    for (const [tabId, shared] of this.tabs) {
      if (shared.stopped)
        result[tabId] = { state: "stopped", reason: shared.stopped };
      else if (!shared.tab.readAlong) continue;
      else if (this.ready && this.accountRoom(shared.roomId))
        result[tabId] = { state: "publishing" };
      else result[tabId] = { state: "paused", buffered: shared.staged.size };
    }
    return result;
  }

  private get account() {
    return this.collaboration.state.auth === "signed_in"
      ? this.collaboration.state.account
      : null;
  }

  // Only rooms shared under the signed-in account publish.
  private accountRoom(roomId: string) {
    const room = this.local?.rooms.find((room) => room.id === roomId);
    return Boolean(
      room?.shared &&
      this.account &&
      room.shared.userId === this.account.id &&
      this.collaboration.rooms.some((item) => item.id === roomId),
    );
  }

  acceptLocal(snapshot: Snapshot) {
    if (this.closed) return;
    if (this.local && snapshot.revision < this.local.revision) return;
    this.local = snapshot;
    const live = new Set<string>();
    for (const room of snapshot.rooms)
      for (const tab of room.tabs) {
        live.add(tab.id);
        let joined = false;
        let shared = this.tabs.get(tab.id);
        if (!shared) {
          if (!tab.readAlongWindows.length) continue;
          shared = {
            roomId: room.id,
            tab,
            raw: new Map(),
            versions: new Map(),
            staged: new Map(),
            dirty: new Set(),
            turnLast: new Map(),
            ended: new Set(),
            midRun: new Map(),
            seeded: false,
            inflight: false,
          };
          this.tabs.set(tab.id, shared);
          // A tab first switched on while ready has nothing on the server to backfill.
          shared.seeded = this.ready && !this.backfilling;
          joined = shared.seeded;
        }
        const reopened =
          tab.readAlongWindows.length > shared.tab.readAlongWindows.length;
        // Leaving running completes every streaming entry held.
        if (tab.status !== shared.tab.status) this.dirtyStreaming(shared);
        shared.tab = tab;
        if (reopened && shared.stopped) {
          shared.stopped = undefined;
          shared.seeded = false;
          void this.backfillTab(tab.id);
        } else if (joined || reopened) void this.join(shared);
        this.restage(shared);
      }
    for (const [tabId, shared] of this.tabs)
      if (!live.has(tabId)) void this.closeTab(tabId, shared);
    this.check();
    this.notify();
  }

  acceptBatches(batches: TranscriptBatch[]) {
    if (this.closed) return;
    for (const batch of batches) {
      const shared = this.tabs.get(batch.tabId);
      if (!shared || shared.stopped) continue;
      for (const entry of batch.entries) this.ingest(shared, entry);
      this.restage(shared);
    }
  }

  /** Called whenever collaboration state or the room list changes. */
  collaborationChanged() {
    if (this.closed) return;
    if (this.collaboration.currentEpoch !== this.epoch) {
      this.epoch = this.collaboration.currentEpoch;
      this.ready = false;
      this.backfilling = undefined;
      for (const shared of this.tabs.values()) {
        clearTimeout(shared.timer);
        shared.timer = undefined;
        shared.staged.clear();
        shared.dirty.clear();
        shared.versions.clear();
        shared.raw.clear();
        shared.midRun.clear();
        shared.noCards = undefined;
        shared.lastRecord = undefined;
        shared.seeded = false;
      }
    }
    // Membership lost: the room is gone from a fresh, connected list of this account's rooms.
    if (this.collaboration.state.status === "connected" && this.account)
      for (const [tabId, shared] of this.tabs) {
        const room = this.local?.rooms.find(
          (room) => room.id === shared.roomId,
        );
        if (
          shared.tab.readAlong &&
          room?.shared?.userId === this.account.id &&
          !this.collaboration.rooms.some((item) => item.id === shared.roomId)
        )
          void this.notMember(tabId, shared);
      }
    this.check();
    this.notify();
  }

  private check() {
    const ready = Boolean(
      this.local &&
      this.account &&
      this.collaboration.state.status === "connected",
    );
    if (ready && !this.ready) {
      this.ready = true;
      void this.backfill();
    } else if (!ready) this.ready = false;
  }

  private ingest(shared: Shared, entry: TranscriptEntry) {
    if (entry.kind === "agent") {
      // Cards update in place long after they were filed, so they follow the switch itself.
      if (!shared.tab.readAlong || shared.noCards || !entry.agent) return;
      if (
        !inReadAlongWindow(shared.tab.readAlongWindows, entry.seq) &&
        !shared.midRun.has(entry.agent.key)
      )
        return;
    } else if (!inReadAlongWindow(shared.tab.readAlongWindows, entry.seq))
      return;
    const held = shared.raw.get(entry.seq);
    if (held && held.updatedAt > entry.updatedAt) return;
    if (entry.turnId && !entry.agentKey) {
      shared.turnLast.set(
        entry.turnId,
        Math.max(shared.turnLast.get(entry.turnId) ?? 0, entry.seq),
      );
      if (entry.kind === "turn") shared.ended.add(entry.turnId);
      // A later entry of the turn may complete its earlier streaming entries.
      this.dirtyStreaming(shared, entry.turnId);
    }
    shared.raw.set(entry.seq, entry);
    shared.dirty.add(entry.seq);
  }

  private dirtyStreaming(shared: Shared, turnId?: string) {
    for (const held of shared.raw.values())
      if (
        STREAMING_KINDS.has(held.kind) &&
        (turnId === undefined || held.turnId === turnId)
      )
        shared.dirty.add(held.seq);
  }

  private complete(shared: Shared, entry: TranscriptEntry) {
    if (!STREAMING_KINDS.has(entry.kind) || shared.closing) return true;
    if (shared.tab.status !== "running") return true;
    if (!entry.turnId) return false;
    return (
      shared.ended.has(entry.turnId) ||
      (shared.turnLast.get(entry.turnId) ?? 0) > entry.seq
    );
  }

  // An entry that will not change again, so only its version needs keeping.
  private settled(shared: Shared, entry: TranscriptEntry) {
    return (
      entry.state !== "pending" &&
      entry.agent?.status !== "running" &&
      this.complete(shared, entry)
    );
  }

  private record(shared: Shared, tab = shared.tab): PublishedRecord {
    const harness = this.local!.harnesses?.find(
      (item) => item.id === tab.loadout.harness,
    );
    return {
      tabId: tab.id,
      roomId: shared.roomId,
      deviceId: this.local!.hostId,
      title: maskCredentials(tab.title).slice(0, 80),
      harness: tab.loadout.harness,
      model: tab.loadout.model.slice(0, 120),
      status: recordStatus(tab),
      switchOn: tab.readAlong,
      ...(tab.readAlong
        ? {
            plan: projectPlan(tab.plan),
            runningAgents: tab.runningAgents ?? 0,
            reportsAgents: harness?.reportsAgents ?? null,
          }
        : {}),
    };
  }

  // Schedules a tick when entries changed or the record differs from the last one published.
  private restage(shared: Shared) {
    if (shared.stopped) return;
    if (
      shared.dirty.size ||
      shared.staged.size ||
      JSON.stringify(this.record(shared)) !== shared.lastRecord
    )
      this.schedule(shared);
  }

  // Projects and masks the changed entries once per tick, bumping a version only when a body
  // changed.
  private project(shared: Shared) {
    if (!shared.seeded || shared.stopped) return;
    for (const seq of shared.dirty) {
      const entry = shared.raw.get(seq);
      if (!entry) continue;
      const known = shared.versions.get(seq);
      // Past the writer's clamp the text no longer only grows; keep what was published.
      if (
        STREAMING_KINDS.has(entry.kind) &&
        entry.summary.length >= WRITER_CLAMP &&
        known
      )
        continue;
      const body = projectEntry(
        entry,
        this.complete(shared, entry),
        entry.agent && shared.midRun.get(entry.agent.key),
      );
      if (!body) continue;
      const json = JSON.stringify(body);
      if (known?.body === json) continue;
      const version = (known?.version ?? 0) + 1;
      shared.versions.set(seq, { version, body: json });
      shared.staged.set(seq, { ...body, version });
    }
    shared.dirty.clear();
  }

  // Up to one publish's worth of staged entries, oldest first.
  private batch(shared: Shared) {
    const entries: PublishedEntry[] = [];
    let bytes = 0;
    for (const entry of [...shared.staged.values()].sort(
      (a, b) => a.seq - b.seq,
    )) {
      const size = JSON.stringify(entry).length;
      if (
        entries.length === MAX_ENTRIES ||
        (entries.length && bytes + size > MAX_BYTES)
      )
        break;
      entries.push(entry);
      bytes += size;
    }
    return entries;
  }

  private schedule(shared: Shared) {
    if (shared.timer || this.closed) return;
    shared.timer = setTimeout(() => {
      shared.timer = undefined;
      void this.flush(shared.tab.id);
    }, this.interval);
    shared.timer.unref?.();
  }

  /** Sends the staged entries and record of one tab. A tab with a publish in flight waits. */
  async flush(tabId: string) {
    const shared = this.tabs.get(tabId);
    if (!shared || shared.stopped) return;
    this.project(shared);
    if (
      shared.inflight ||
      !this.ready ||
      !shared.seeded ||
      !this.accountRoom(shared.roomId)
    ) {
      if (shared.inflight || shared.staged.size || shared.dirty.size)
        this.schedule(shared);
      this.notify();
      return;
    }
    const record = this.record(shared);
    if (!shared.staged.size && JSON.stringify(record) === shared.lastRecord)
      return;
    const entries = this.batch(shared);
    const epoch = this.epoch;
    shared.inflight = true;
    const outcome = await this.collaboration.readAlong<Head>(
      "desktop_tab_share_publish",
      { p_tab: record, p_entries: entries },
    );
    shared.inflight = false;
    if (epoch !== this.epoch || this.tabs.get(tabId) !== shared) return;
    if (outcome.ok) {
      shared.lastRecord = JSON.stringify(record);
      for (const entry of entries) {
        if (shared.staged.get(entry.seq)?.version === entry.version)
          shared.staged.delete(entry.seq);
        // Settled entries no longer change; keep only their version.
        const raw = shared.raw.get(entry.seq);
        if (raw && this.settled(shared, raw) && !shared.staged.has(entry.seq)) {
          shared.raw.delete(entry.seq);
          shared.versions.set(entry.seq, { version: entry.version });
        }
      }
    } else if (
      outcome.reason === "invalid" &&
      entries.some((entry) => entry.kind === "agent")
    ) {
      // A database without the sub-agent migration refuses cards; the transcript goes on.
      shared.noCards = true;
      for (const [seq, entry] of shared.staged)
        if (entry.kind === "agent") {
          shared.staged.delete(seq);
          shared.raw.delete(seq);
        }
    } else if (outcome.reason === "not_member")
      await this.notMember(tabId, shared);
    else if (outcome.reason === "migration_missing") {
      shared.stopped = "migration_missing";
      this.notify();
      return;
    }
    this.restage(shared);
    this.notify();
  }

  // The host left the room: stop sharing without publishing anything else from this window.
  private async notMember(tabId: string, shared: Shared) {
    if (shared.stopped === "not_member") return;
    shared.stopped = "not_member";
    clearTimeout(shared.timer);
    shared.timer = undefined;
    shared.staged.clear();
    shared.dirty.clear();
    shared.raw.clear();
    this.notify();
    if (shared.tab.readAlong)
      await this.supervisor.request({
        type: "tab.setReadAlong",
        roomId: shared.roomId,
        tabId,
        on: false,
        discard: true,
      });
    void this.collaboration.refresh().catch(() => {});
  }

  private async closeTab(tabId: string, shared: Shared) {
    this.tabs.delete(tabId);
    clearTimeout(shared.timer);
    // The last publish carries every held entry in its final state, then the closed record.
    shared.closing = true;
    this.dirtyStreaming(shared);
    this.project(shared);
    // Offline closes are caught by the next reconcile, which lists live tabs only.
    if (
      !this.ready ||
      !shared.seeded ||
      (shared.lastRecord === undefined && !shared.staged.size) ||
      !this.accountRoom(shared.roomId)
    )
      return;
    await this.collaboration.readAlong("desktop_tab_share_publish", {
      p_tab: { ...this.record(shared), status: "closed", switchOn: false },
      p_entries: this.batch(shared),
    });
  }

  // Reconcile, then seed and backfill every shared tab from its server head.
  private backfill() {
    const epoch = this.epoch;
    const work = (async () => {
      const local = this.local!;
      const tabIds = local.rooms.flatMap((room) =>
        room.tabs.map((tab) => tab.id),
      );
      const reconciled = await this.collaboration.readAlong(
        "desktop_tab_share_reconcile",
        { p_device_id: local.hostId, p_live_tab_ids: tabIds.slice(0, 500) },
      );
      if (epoch !== this.epoch) return;
      if (!reconciled.ok) {
        if (reconciled.reason === "migration_missing")
          for (const shared of this.tabs.values())
            shared.stopped = "migration_missing";
        else this.ready = false;
        this.notify();
        return;
      }
      for (const tabId of [...this.tabs.keys()]) await this.backfillTab(tabId);
    })();
    this.backfilling = work;
    return work.finally(() => {
      if (this.backfilling === work) this.backfilling = undefined;
    });
  }

  private async page(shared: Shared, command: Record<string, unknown>) {
    const result = await this.supervisor.request({
      type: "tab.transcript",
      roomId: shared.roomId,
      tabId: shared.tab.id,
      ...command,
    } as SupervisorRequest["command"]);
    return result.ok ? (result.transcript as TranscriptPage) : undefined;
  }

  private async cards(shared: Shared) {
    const result = await this.supervisor.request({
      type: "tab.agents",
      roomId: shared.roomId,
      tabId: shared.tab.id,
    });
    const page = result.ok
      ? (result.transcript as TranscriptPage | undefined)
      : undefined;
    return page?.entries ?? [];
  }

  // Takes in the tab's cards: those running outside every window join mid-run, and cards the
  // publisher holds, the server stores as running, or the server has not seen are refreshed.
  private adopt(
    shared: Shared,
    cards: TranscriptEntry[],
    stored: Set<number>,
    afterSeq: number,
  ) {
    if (!shared.tab.readAlong) return;
    for (const entry of cards) {
      const card = entry.agent;
      if (!card) continue;
      const inWindow = inReadAlongWindow(
        shared.tab.readAlongWindows,
        entry.seq,
      );
      if (
        !inWindow &&
        !shared.midRun.has(card.key) &&
        (card.status === "running" || stored.has(entry.seq))
      )
        shared.midRun.set(card.key, { latestTool: card.latestTool });
      if (
        !shared.midRun.has(card.key) &&
        !(inWindow && (entry.seq > afterSeq || stored.has(entry.seq))) &&
        !shared.raw.has(entry.seq)
      )
        continue;
      const held = shared.raw.get(entry.seq);
      if (held && held.updatedAt > entry.updatedAt) continue;
      shared.raw.delete(entry.seq);
      this.ingest(shared, entry);
    }
  }

  // A window opened on a live tab: sub-agents already running join mid-run, once per window.
  private async join(shared: Shared) {
    const windows = shared.tab.readAlongWindows.length;
    const cards = await this.cards(shared);
    if (
      this.closed ||
      this.tabs.get(shared.tab.id) !== shared ||
      shared.stopped ||
      shared.tab.readAlongWindows.length !== windows
    )
      return;
    this.adopt(shared, cards, new Set(), Infinity);
    this.restage(shared);
  }

  private async backfillTab(tabId: string) {
    const shared = this.tabs.get(tabId);
    if (!shared || shared.stopped || !this.accountRoom(shared.roomId)) return;
    const epoch = this.epoch;
    const head = await this.collaboration.readAlong<Head | null>(
      "desktop_tab_share_head",
      { p_tab_id: tabId },
    );
    if (epoch !== this.epoch || this.tabs.get(tabId) !== shared) return;
    if (!head.ok) {
      if (head.reason === "not_member") await this.notMember(tabId, shared);
      else if (head.reason === "migration_missing")
        shared.stopped = "migration_missing";
      this.notify();
      return;
    }
    // Seed counters above the stored versions, so every republish supersedes them.
    const seeds = [
      ...(head.data?.maxSeq && head.data.version
        ? [{ seq: head.data.maxSeq, version: head.data.version }]
        : []),
      ...(head.data?.pending ?? []),
    ];
    for (const { seq, version } of seeds) {
      const known = shared.versions.get(seq)?.version ?? 0;
      shared.versions.set(seq, { version: Math.max(known, version) });
    }
    const entries: TranscriptEntry[] = [];
    for (const { seq } of seeds) {
      const page = await this.page(shared, { beforeSeq: seq + 1, limit: 1 });
      const entry = page?.entries.find((item) => item.seq === seq);
      if (entry) entries.push(entry);
    }
    let after = head.data?.maxSeq ?? 0;
    for (;;) {
      const page = await this.page(shared, { afterSeq: after, limit: 200 });
      if (!page) break;
      entries.push(...page.entries);
      if (page.nextSeq === null) break;
      after = page.nextSeq;
    }
    // Transcript pages leave cards out. Cards the server stores as running are re-read too, so
    // one that settled while the host was away republishes settled.
    const cards = await this.cards(shared);
    if (epoch !== this.epoch || this.tabs.get(tabId) !== shared) return;
    for (const entry of entries) {
      // Journal entries replace held ones at equal time, so seeded entries restage.
      const held = shared.raw.get(entry.seq);
      if (held && held.updatedAt > entry.updatedAt) continue;
      shared.raw.delete(entry.seq);
      this.ingest(shared, entry);
    }
    this.adopt(
      shared,
      cards,
      new Set(seeds.map((seed) => seed.seq)),
      head.data?.maxSeq ?? 0,
    );
    shared.seeded = true;
    shared.lastRecord = undefined;
    for (const seq of shared.raw.keys()) shared.dirty.add(seq);
    this.restage(shared);
    this.notify();
  }

  close() {
    this.closed = true;
    for (const shared of this.tabs.values()) clearTimeout(shared.timer);
  }
}
