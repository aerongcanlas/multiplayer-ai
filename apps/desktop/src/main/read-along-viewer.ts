import {
  sharedPullSchema,
  type SharedEntry,
  type SharedTab,
  type SharedTranscriptMessage,
} from "../shared/collaboration";
import type { CollaborationClient } from "./collaboration-client";

const INTERVAL_MS = 1_000;
const PAGE = 200;
const BYTE_BUDGET = 1_048_576;
// The initial page's cursor: every entry at or below the record's rev has been read.
const MAX_SEQ = 2_147_483_647;
// Transcript pages ask for these kinds once a tab has cards, so cards never fill a page.
const LEAD_KINDS = [
  "user",
  "assistant",
  "plan",
  "tool",
  "approval",
  "notice",
  "error",
  "turn",
];
// The cards load stops after this many pages and says it shows the latest cards.
const CARD_PAGES = 5;

type Collaboration = Pick<
  CollaborationClient,
  "state" | "currentEpoch" | "readAlong"
>;
interface Watch {
  roomId: string;
  tabId: string;
  epoch: number;
  cursor?: { rev: number; seq: number };
  record?: SharedTab;
  // Set once the one-time cards load has answered. `unavailable` means the database predates
  // the kinds filter, so no pull sends it.
  cards?: "ready" | "capped" | "unavailable";
  // The record rev the cards load read at; the tail starts no later than it.
  cardsRev?: number;
  // The newest version delivered per card, so a re-read never re-delivers a stale one.
  cardVersions: Map<number, number>;
  inflight: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Pulls one watched shared tab for the renderer. It polls every second while the tab's record
 * says running or awaiting the host and the window is visible, and otherwise pulls once per room
 * snapshot. Every row is parsed with a strict schema here, and a batch that fails is dropped.
 */
export class ReadAlongViewer {
  private watching?: Watch;
  private epoch: number;

  constructor(
    private collaboration: Collaboration,
    // The shared tabs listed for a room in the current view, after own-device filtering.
    private listed: (roomId: string) => SharedTab[] | undefined,
    private send: (message: SharedTranscriptMessage) => void,
    private visible: () => boolean,
    private interval = INTERVAL_MS,
  ) {
    this.epoch = collaboration.currentEpoch;
  }

  async watch(roomId: string, tabId: string) {
    if (!this.listed(roomId)?.some((tab) => tab.tabId === tabId))
      throw new Error("That shared tab is no longer available.");
    if (
      this.watching?.roomId === roomId &&
      this.watching.tabId === tabId &&
      this.watching.epoch === this.collaboration.currentEpoch
    )
      return;
    this.unwatch();
    const watch: Watch = {
      roomId,
      tabId,
      epoch: this.collaboration.currentEpoch,
      cardVersions: new Map(),
      inflight: false,
    };
    this.watching = watch;
    this.send({ type: "status", roomId, tabId, state: "loading" });
    await this.pull(watch);
  }

  unwatch() {
    if (this.watching) clearTimeout(this.watching.timer);
    this.watching = undefined;
  }

  /** An older page of the watched tab, newest first below `beforeSeq`. */
  async loadEarlier(roomId: string, tabId: string, beforeSeq: number) {
    const watch = this.watching;
    if (!watch || watch.roomId !== roomId || watch.tabId !== tabId)
      throw new Error("Open the shared tab before loading its history.");
    const page = await this.request(watch, {
      p_after_rev: null,
      p_after_seq: null,
      p_before_seq: beforeSeq,
      ...this.leadKinds(watch),
    });
    if (page === "stale") return;
    if (!page.ok) throw new Error("Could not load earlier shared entries.");
    this.send({
      type: "entries",
      roomId,
      tabId,
      record: page.data.record,
      entries: this.split(watch, page.data.entries),
      earlierSeq: page.data.next?.seq ?? null,
      now: page.data.now,
    });
  }

  /** Called after each room snapshot or collaboration change. */
  snapshotChanged() {
    if (this.collaboration.currentEpoch !== this.epoch) {
      this.epoch = this.collaboration.currentEpoch;
      this.unwatch();
      this.send({ type: "clear" });
      return;
    }
    const watch = this.watching;
    if (!watch) return;
    if (this.collaboration.state.status !== "connected") {
      this.send({
        type: "status",
        roomId: watch.roomId,
        tabId: watch.tabId,
        state: "reconnecting",
      });
      return;
    }
    if (!this.listed(watch.roomId)?.some((tab) => tab.tabId === watch.tabId)) {
      // Closed, or the host left the room: the list drops the tab.
      this.unwatch();
      this.send({
        type: "status",
        roomId: watch.roomId,
        tabId: watch.tabId,
        state: "unshared",
      });
      return;
    }
    if (!watch.timer) void this.pull(watch);
  }

  /** The window was shown: pull at once. */
  visibilityChanged() {
    const watch = this.watching;
    if (watch && this.visible()) void this.pull(watch);
  }

  // A tab with no cards keeps the pull it always sent.
  private leadKinds(watch: Watch): { p_kinds?: string[] } {
    return watch.cards !== "unavailable" && watch.cardVersions.size
      ? { p_kinds: LEAD_KINDS }
      : {};
  }

  // Sends the cards among pulled entries on their own and returns the lead's entries.
  private split(
    watch: Watch,
    entries: SharedEntry[],
    state?: "ready" | "capped" | "unavailable",
  ) {
    const cards = entries.filter((entry) => {
      if (entry.kind !== "agent") return false;
      if ((watch.cardVersions.get(entry.seq) ?? 0) >= entry.version)
        return false;
      watch.cardVersions.set(entry.seq, entry.version);
      return true;
    });
    if (cards.length || state)
      this.send({
        type: "cards",
        roomId: watch.roomId,
        tabId: watch.tabId,
        cards,
        ...(state ? { state } : {}),
      });
    return entries.filter((entry) => entry.kind !== "agent");
  }

  // Loads every card of the tab once, newest first, apart from the lead transcript. A database
  // without the kinds filter rejects the call as not found: cards are then unavailable.
  private async loadCards(watch: Watch): Promise<void> {
    const cards: SharedEntry[] = [];
    let before: number | null = null;
    let more = false;
    for (let pages = 0; pages < CARD_PAGES; pages++) {
      const page = await this.request(watch, {
        p_after_rev: null,
        p_after_seq: null,
        p_before_seq: before,
        p_kinds: ["agent"],
      });
      if (page === "stale") return;
      if (!page.ok) {
        if (page.reason !== "migration_missing") return;
        watch.cards = "unavailable";
        this.split(watch, [], "unavailable");
        return;
      }
      watch.cardsRev ??= page.data.record.rev;
      cards.push(...page.data.entries);
      more = Boolean(page.data.next);
      if (!page.data.next) break;
      before = page.data.next.seq;
    }
    watch.cards = more ? "capped" : "ready";
    this.split(watch, cards, watch.cards);
  }

  private async request(
    watch: Watch,
    cursor: Record<string, number | string[] | null | undefined>,
  ): Promise<
    | "stale"
    | { ok: true; data: ReturnType<typeof sharedPullSchema.parse> }
    | { ok: false; reason: string }
  > {
    const outcome = await this.collaboration.readAlong<unknown>(
      "desktop_tab_share_pull",
      {
        p_tab_id: watch.tabId,
        p_before_seq: null,
        p_limit: PAGE,
        p_byte_budget: BYTE_BUDGET,
        ...cursor,
      },
    );
    if (
      this.watching !== watch ||
      watch.epoch !== this.collaboration.currentEpoch
    )
      return "stale";
    if (!outcome.ok) return outcome;
    const parsed = sharedPullSchema.safeParse(outcome.data);
    if (!parsed.success) {
      console.warn("Dropped a shared transcript page that failed validation.");
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, data: parsed.data };
  }

  private async pull(watch: Watch): Promise<void> {
    if (watch.inflight || this.watching !== watch) return;
    clearTimeout(watch.timer);
    watch.timer = undefined;
    watch.inflight = true;
    const initial = !watch.cursor;
    // Cards load before the first transcript page, and again on a later pull if that failed.
    if (!watch.cards) await this.loadCards(watch);
    if (this.watching !== watch) return;
    const page = await this.request(
      watch,
      watch.cursor
        ? { p_after_rev: watch.cursor.rev, p_after_seq: watch.cursor.seq }
        : { p_after_rev: null, p_after_seq: null, ...this.leadKinds(watch) },
    );
    watch.inflight = false;
    if (page === "stale") return;
    const { roomId, tabId } = watch;
    if (!page.ok) {
      if (page.reason === "not_member") {
        this.unwatch();
        this.send({ type: "status", roomId, tabId, state: "unshared" });
      } else if (page.reason === "invalid") {
        // Keep the cursor; a later pull may carry a valid page.
      } else
        this.send({
          type: "status",
          roomId,
          tabId,
          state:
            initial || page.reason === "migration_missing"
              ? "failed"
              : "reconnecting",
        });
      if (page.reason === "retry" && !initial) this.schedule(watch);
      return;
    }
    const { record, entries, next, now } = page.data;
    watch.record = record;
    // The cards were read first, so the tail starts at their rev and misses no card update.
    if (initial)
      watch.cursor = {
        rev: Math.min(record.rev, watch.cardsRev ?? record.rev),
        seq: MAX_SEQ,
      };
    else if (next) watch.cursor = next;
    else if (entries.length)
      watch.cursor = { rev: entries.at(-1)!.rev, seq: entries.at(-1)!.seq };
    this.send({
      type: "entries",
      roomId,
      tabId,
      record,
      entries: this.split(watch, entries),
      ...(initial ? { earlierSeq: next?.seq ?? null } : {}),
      now,
    });
    this.send({ type: "status", roomId, tabId, state: "live" });
    // A page cut by the byte budget continues at once.
    if (!initial && next) return this.pull(watch);
    this.schedule(watch);
  }

  private schedule(watch: Watch) {
    const active =
      watch.record?.status === "running" ||
      watch.record?.status === "awaiting_host";
    if (!active || !this.visible() || this.watching !== watch) return;
    watch.timer = setTimeout(() => {
      watch.timer = undefined;
      void this.pull(watch);
    }, this.interval);
    watch.timer.unref?.();
  }

  close() {
    this.unwatch();
  }
}
