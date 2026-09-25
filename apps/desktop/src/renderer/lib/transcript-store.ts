import { useEffect, useSyncExternalStore } from "react";
import type { TranscriptBatch, TranscriptEntry } from "../../shared/tabs";
import { acceptAgents } from "./agents-store";

interface TabTranscript {
  entries: TranscriptEntry[];
  // The seq to page back from, or null once the start is loaded.
  nextSeq: number | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

const empty: TabTranscript = {
  entries: [],
  nextSeq: null,
  loaded: false,
  loading: false,
  error: null,
};
// Keyed by tab and agent key: the lead's transcript, or one sub-agent's drill-in.
const transcripts = new Map<string, TabTranscript>();
const listeners = new Set<() => void>();
const keyOf = (tabId: string, agentKey?: string | null) =>
  `${tabId}\0${agentKey ?? ""}`;

function set(key: string, next: TabTranscript) {
  transcripts.set(key, next);
  for (const listener of listeners) listener();
}

/** Upserts entries by seq; streamed updates replace the entry they grow. */
function merge(current: TranscriptEntry[], incoming: TranscriptEntry[]) {
  const bySeq = new Map(current.map((entry) => [entry.seq, entry]));
  for (const entry of incoming) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Where a live entry shows, matching the journal's pages. */
function destinations(entry: TranscriptEntry) {
  if (!entry.agentKey) return [keyOf(entry.tabId)];
  const own = keyOf(entry.tabId, entry.agentKey);
  // A sub-agent's request waits in the lead's view as well (R18).
  return entry.kind === "approval" || entry.kind === "question"
    ? [keyOf(entry.tabId), own]
    : [own];
}

export function acceptTranscript(batches: TranscriptBatch[]) {
  acceptAgents(
    batches.flatMap((batch) =>
      batch.entries.filter((entry) => entry.kind === "agent"),
    ),
  );
  const incoming = new Map<string, TranscriptEntry[]>();
  for (const batch of batches)
    for (const entry of batch.entries)
      if (entry.kind !== "agent")
        for (const key of destinations(entry))
          incoming.set(key, [...(incoming.get(key) ?? []), entry]);
  for (const [key, entries] of incoming) {
    const current = transcripts.get(key) ?? empty;
    set(key, { ...current, entries: merge(current.entries, entries) });
  }
}

async function load(
  roomId: string,
  tabId: string,
  agentKey: string | null,
  older: boolean,
) {
  const key = keyOf(tabId, agentKey);
  const current = transcripts.get(key) ?? empty;
  if (current.loading || (!older && current.loaded)) return;
  if (older && current.nextSeq === null) return;
  set(key, { ...current, loading: true, error: null });
  try {
    const result = await window.desktop.loadTranscript(
      roomId,
      tabId,
      older ? (current.nextSeq ?? undefined) : undefined,
      agentKey ?? undefined,
    );
    const latest = transcripts.get(key) ?? empty;
    if (!result.ok || !result.transcript) {
      set(key, {
        ...latest,
        loading: false,
        error: result.ok ? "The transcript could not be loaded." : result.error,
      });
      return;
    }
    const page = result.transcript;
    set(key, {
      entries: merge(page.entries, latest.entries),
      // Paging back from the first page sets where older history starts.
      nextSeq: older || !latest.loaded ? page.nextSeq : latest.nextSeq,
      loaded: true,
      loading: false,
      error: null,
    });
  } catch {
    set(key, {
      ...(transcripts.get(key) ?? empty),
      loading: false,
      error: "The transcript could not be loaded.",
    });
  }
}

export const loadOlder = (
  roomId: string,
  tabId: string,
  agentKey: string | null = null,
) => void load(roomId, tabId, agentKey, true);

/** A tab's transcript, or one sub-agent's with `agentKey`, loading its latest page on first open. */
export function useTranscript(
  roomId: string,
  tabId: string | null,
  agentKey: string | null = null,
) {
  const transcript = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (tabId ? (transcripts.get(keyOf(tabId, agentKey)) ?? empty) : empty),
  );
  useEffect(() => {
    if (tabId) void load(roomId, tabId, agentKey, false);
  }, [roomId, tabId, agentKey]);
  return transcript;
}

export function connectTranscripts() {
  if (!window.desktop) return () => {};
  return window.desktop.onTranscript(acceptTranscript);
}
