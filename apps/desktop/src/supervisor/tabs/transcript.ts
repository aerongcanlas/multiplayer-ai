import { randomUUID } from "node:crypto";
import {
  SHARE_LEVELS,
  type TranscriptBatch,
  type TranscriptEntry,
} from "../../shared/tabs";

const MAX_TEXT = 200_000;
const clampEnd = (text: string) =>
  text.length > MAX_TEXT ? text.slice(-MAX_TEXT) : text;
/** A shareable one-line summary. */
export const oneLine = (text: string, limit = 400) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

const itemKey = (
  tabId: string,
  turnId: string | null,
  agentKey: string | undefined,
  item: string,
) => `${tabId}\0${turnId ?? ""}\0${agentKey ?? ""}\0${item}`;

export type EntryInput = Pick<TranscriptEntry, "turnId" | "kind" | "summary"> &
  Partial<
    Omit<
      TranscriptEntry,
      "id" | "tabId" | "seq" | "createdAt" | "updatedAt" | "share"
    >
  >;

interface Store {
  saveTranscript(entries: TranscriptEntry[]): void;
  lastSeq(tabId: string): number;
}

/**
 * Normalizes harness output into transcript entries: assigns seq and share levels, coalesces
 * streamed deltas into one entry per item, and flushes changed entries in batches to the journal
 * and to the renderer about every 100 ms. Entries are persisted at flush time, not per token.
 */
export class TranscriptWriter {
  private seqs = new Map<string, number>();
  private live = new Map<string, { roomId: string; entry: TranscriptEntry }>();
  private items = new Map<string, string>();
  private dirty = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    private store: Store,
    private emit: (batches: TranscriptBatch[]) => void,
    private interval = 100,
  ) {}

  private nextSeq(tabId: string) {
    const seq = (this.seqs.get(tabId) ?? this.store.lastSeq(tabId)) + 1;
    this.seqs.set(tabId, seq);
    return seq;
  }

  private touch(id: string) {
    this.dirty.add(id);
    if (!this.timer && !this.closed)
      this.timer = setTimeout(() => this.flush(), this.interval);
  }

  append(roomId: string, tabId: string, input: EntryInput): TranscriptEntry {
    const now = new Date().toISOString();
    const entry: TranscriptEntry = {
      ...input,
      id: randomUUID(),
      tabId,
      seq: this.nextSeq(tabId),
      share: SHARE_LEVELS[input.kind],
      summary: clampEnd(input.summary),
      ...(input.detail !== undefined ? { detail: clampEnd(input.detail) } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.live.set(entry.id, { roomId, entry });
    this.touch(entry.id);
    return entry;
  }

  /** Keeps an entry loaded from the journal (for example a pending approval) editable. */
  adopt(roomId: string, entry: TranscriptEntry) {
    this.live.set(entry.id, { roomId, entry: structuredClone(entry) });
  }

  entry(id: string): TranscriptEntry | undefined {
    return this.live.get(id)?.entry;
  }

  update(
    id: string,
    patch: Partial<
      Omit<TranscriptEntry, "id" | "tabId" | "seq" | "kind" | "share">
    >,
  ): TranscriptEntry | undefined {
    const live = this.live.get(id);
    if (!live) return undefined;
    Object.assign(live.entry, patch, { updatedAt: new Date().toISOString() });
    if (patch.summary !== undefined)
      live.entry.summary = clampEnd(patch.summary);
    if (patch.detail !== undefined) live.entry.detail = clampEnd(patch.detail);
    this.touch(id);
    return live.entry;
  }

  /** Streams text into the entry for one harness item, creating it on the first delta. */
  text(
    roomId: string,
    tabId: string,
    turnId: string | null,
    item: string,
    kind: "assistant" | "reasoning" | "plan",
    text: string,
    replace = false,
    agentKey?: string,
  ) {
    const key = itemKey(tabId, turnId, agentKey, item);
    const existing = this.items.get(key);
    const entry = existing && this.live.get(existing)?.entry;
    if (!entry) {
      this.items.set(
        key,
        this.append(roomId, tabId, {
          turnId,
          kind,
          summary: text,
          ...(agentKey ? { agentKey } : {}),
        }).id,
      );
      return;
    }
    this.update(entry.id, { summary: replace ? text : entry.summary + text });
  }

  /** Creates or updates the tool entry for one harness item. Returns whether it was new. */
  tool(
    roomId: string,
    tabId: string,
    turnId: string | null,
    item: string,
    summary: string,
    detail?: string,
    agentKey?: string,
  ): boolean {
    const key = itemKey(tabId, turnId, agentKey, `tool\0${item}`);
    const existing = this.items.get(key);
    const patch = {
      summary: oneLine(summary),
      ...(detail !== undefined ? { detail } : {}),
    };
    if (existing && this.live.has(existing)) {
      this.update(existing, patch);
      return false;
    }
    this.items.set(
      key,
      this.append(roomId, tabId, {
        turnId,
        kind: "tool",
        ...patch,
        ...(agentKey ? { agentKey } : {}),
      }).id,
    );
    return true;
  }

  /** Entries of a tab's turn, oldest first. */
  turnEntries(tabId: string, turnId: string) {
    return [...this.live.values()]
      .map((live) => live.entry)
      .filter((entry) => entry.tabId === tabId && entry.turnId === turnId)
      .sort((a, b) => a.seq - b.seq);
  }

  pending(tabId: string) {
    return [...this.live.values()]
      .map((live) => live.entry)
      .filter((entry) => entry.tabId === tabId && entry.state === "pending");
  }

  /**
   * Drops finished entries of a tab from memory once flushed. Running sub-agent cards and their
   * entries stay editable, since they keep growing after the turn that spawned them.
   */
  release(tabId: string) {
    this.flush();
    const running = new Set(
      [...this.live.values()]
        .map((live) => live.entry)
        .filter(
          (entry) =>
            entry.tabId === tabId && entry.agent?.status === "running",
        )
        .map((entry) => entry.agent!.key),
    );
    for (const [id, { entry }] of this.live)
      if (
        entry.tabId === tabId &&
        entry.state !== "pending" &&
        !(entry.agent && running.has(entry.agent.key)) &&
        !(entry.agentKey && running.has(entry.agentKey))
      )
        this.live.delete(id);
    for (const [key, id] of this.items)
      if (!this.live.has(id)) this.items.delete(key);
  }

  /** Forgets a closed tab entirely; its entries are deleted from the journal by the caller. */
  forget(tabId: string) {
    for (const id of [...this.dirty])
      if (this.live.get(id)?.entry.tabId === tabId) this.dirty.delete(id);
    for (const [id, live] of this.live)
      if (live.entry.tabId === tabId) this.live.delete(id);
    this.seqs.delete(tabId);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty.size) return;
    const changed = [...this.dirty]
      .map((id) => this.live.get(id))
      .filter((live) => live !== undefined);
    this.dirty.clear();
    this.store.saveTranscript(changed.map((live) => live.entry));
    const batches = new Map<string, TranscriptBatch>();
    for (const { roomId, entry } of changed) {
      const batch = batches.get(entry.tabId) ?? {
        roomId,
        tabId: entry.tabId,
        entries: [],
      };
      batch.entries.push(structuredClone(entry));
      batches.set(entry.tabId, batch);
    }
    this.emit([...batches.values()]);
  }

  close() {
    this.flush();
    this.closed = true;
  }
}
