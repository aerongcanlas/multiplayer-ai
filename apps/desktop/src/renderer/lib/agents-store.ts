import { useEffect, useSyncExternalStore } from "react";
import type { TranscriptEntry } from "../../shared/tabs";

interface TabAgents {
  // Sub-agent cards, oldest first.
  cards: TranscriptEntry[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

const empty: TabAgents = {
  cards: [],
  loaded: false,
  loading: false,
  error: null,
};
const tabs = new Map<string, TabAgents>();
const listeners = new Set<() => void>();

function set(tabId: string, next: TabAgents) {
  tabs.set(tabId, next);
  for (const listener of listeners) listener();
}

function merge(current: TranscriptEntry[], incoming: TranscriptEntry[]) {
  const bySeq = new Map(current.map((entry) => [entry.seq, entry]));
  for (const entry of incoming) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Live card updates from transcript batches. */
export function acceptAgents(entries: TranscriptEntry[]) {
  const byTab = new Map<string, TranscriptEntry[]>();
  for (const entry of entries)
    byTab.set(entry.tabId, [...(byTab.get(entry.tabId) ?? []), entry]);
  for (const [tabId, cards] of byTab) {
    const current = tabs.get(tabId) ?? empty;
    set(tabId, { ...current, cards: merge(current.cards, cards) });
  }
}

async function load(roomId: string, tabId: string) {
  const current = tabs.get(tabId) ?? empty;
  if (current.loading || current.loaded) return;
  set(tabId, { ...current, loading: true, error: null });
  try {
    const result = await window.desktop.loadAgents(roomId, tabId);
    const latest = tabs.get(tabId) ?? empty;
    set(
      tabId,
      result.ok && result.transcript
        ? {
            cards: merge(result.transcript.entries, latest.cards),
            loaded: true,
            loading: false,
            error: null,
          }
        : {
            ...latest,
            loading: false,
            error: result.ok ? "Sub-agents could not be loaded." : result.error,
          },
    );
  } catch {
    set(tabId, {
      ...(tabs.get(tabId) ?? empty),
      loading: false,
      error: "Sub-agents could not be loaded.",
    });
  }
}

/** A tab's sub-agent cards, loading them on first view; `loaded` is false until they arrive. */
export function useAgents(roomId: string, tabId: string | null) {
  const agents = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (tabId ? (tabs.get(tabId) ?? empty) : empty),
  );
  useEffect(() => {
    if (tabId) void load(roomId, tabId);
  }, [roomId, tabId]);
  return agents;
}
