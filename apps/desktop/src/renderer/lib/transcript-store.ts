import { useEffect, useSyncExternalStore } from "react";
import type { TranscriptBatch, TranscriptEntry } from "../../shared/tabs";

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
const tabs = new Map<string, TabTranscript>();
const listeners = new Set<() => void>();

function set(tabId: string, next: TabTranscript) {
  tabs.set(tabId, next);
  for (const listener of listeners) listener();
}

/** Upserts entries by seq; streamed updates replace the entry they grow. */
function merge(current: TranscriptEntry[], incoming: TranscriptEntry[]) {
  const bySeq = new Map(current.map((entry) => [entry.seq, entry]));
  for (const entry of incoming) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function acceptTranscript(batches: TranscriptBatch[]) {
  for (const batch of batches) {
    const current = tabs.get(batch.tabId) ?? empty;
    set(batch.tabId, {
      ...current,
      entries: merge(current.entries, batch.entries),
    });
  }
}

async function load(roomId: string, tabId: string, older: boolean) {
  const current = tabs.get(tabId) ?? empty;
  if (current.loading || (!older && current.loaded)) return;
  if (older && current.nextSeq === null) return;
  set(tabId, { ...current, loading: true, error: null });
  try {
    const result = await window.desktop.loadTranscript(
      roomId,
      tabId,
      older ? (current.nextSeq ?? undefined) : undefined,
    );
    const latest = tabs.get(tabId) ?? empty;
    if (!result.ok || !result.transcript) {
      set(tabId, {
        ...latest,
        loading: false,
        error: result.ok ? "The transcript could not be loaded." : result.error,
      });
      return;
    }
    const page = result.transcript;
    set(tabId, {
      entries: merge(page.entries, latest.entries),
      // Paging back from the first page sets where older history starts.
      nextSeq: older || !latest.loaded ? page.nextSeq : latest.nextSeq,
      loaded: true,
      loading: false,
      error: null,
    });
  } catch {
    set(tabId, {
      ...(tabs.get(tabId) ?? empty),
      loading: false,
      error: "The transcript could not be loaded.",
    });
  }
}

export const loadOlder = (roomId: string, tabId: string) =>
  void load(roomId, tabId, true);

/** A tab's transcript, loading its latest page on first open. */
export function useTranscript(roomId: string, tabId: string | null) {
  const transcript = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (tabId ? (tabs.get(tabId) ?? empty) : empty),
  );
  useEffect(() => {
    if (tabId) void load(roomId, tabId, false);
  }, [roomId, tabId]);
  return transcript;
}

export function connectTranscripts() {
  if (!window.desktop) return () => {};
  return window.desktop.onTranscript(acceptTranscript);
}
