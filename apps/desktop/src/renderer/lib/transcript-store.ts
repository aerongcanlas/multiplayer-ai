import { useEffect, useSyncExternalStore } from "react";
import type {
  AgentEntry,
  TranscriptBatch,
  TranscriptEntry,
} from "../../shared/tabs";

interface Loadable {
  loaded: boolean;
  loading: boolean;
  error: string | null;
}
interface TabTranscript extends Loadable {
  entries: TranscriptEntry[];
  // The seq to page back from, or null once the start is loaded.
  nextSeq: number | null;
}
interface TabAgents extends Loadable {
  // Sub-agent cards, oldest first.
  cards: AgentEntry[];
}

const idle: Loadable = { loaded: false, loading: false, error: null };
const emptyTranscript: TabTranscript = { ...idle, entries: [], nextSeq: null };
const emptyAgents: TabAgents = { ...idle, cards: [] };
// Keyed by tab and agent key: the lead's transcript, or one sub-agent's drill-in.
const transcripts = new Map<string, TabTranscript>();
// Keyed by tab.
const agents = new Map<string, TabAgents>();
const listeners = new Set<() => void>();
const keyOf = (tabId: string, agentKey?: string | null) =>
  `${tabId}\0${agentKey ?? ""}`;

function set<T>(store: Map<string, T>, key: string, next: T) {
  store.set(key, next);
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Upserts entries by seq; streamed updates replace the entry they grow. */
function merge<T extends { seq: number }>(current: T[], incoming: T[]) {
  const bySeq = new Map(current.map((entry) => [entry.seq, entry]));
  for (const entry of incoming) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

const isAgent = (entry: TranscriptEntry): entry is AgentEntry =>
  entry.kind === "agent";

const push = <T>(groups: Map<string, T[]>, key: string, item: T) =>
  groups.set(key, [...(groups.get(key) ?? []), item]);

/** Where a live entry shows, matching the journal's pages. */
function destinations(entry: TranscriptEntry) {
  if (!entry.agentKey) return [keyOf(entry.tabId)];
  const own = keyOf(entry.tabId, entry.agentKey);
  // A sub-agent's request waits in the lead's view as well.
  return entry.kind === "approval" || entry.kind === "question"
    ? [keyOf(entry.tabId), own]
    : [own];
}

function acceptTranscript(batches: TranscriptBatch[]) {
  const cards = new Map<string, AgentEntry[]>();
  const incoming = new Map<string, TranscriptEntry[]>();
  for (const batch of batches)
    for (const entry of batch.entries)
      if (isAgent(entry)) push(cards, entry.tabId, entry);
      else for (const key of destinations(entry)) push(incoming, key, entry);
  for (const [tabId, entries] of cards) {
    const current = agents.get(tabId) ?? emptyAgents;
    set(agents, tabId, { ...current, cards: merge(current.cards, entries) });
  }
  for (const [key, entries] of incoming) {
    const current = transcripts.get(key) ?? emptyTranscript;
    set(transcripts, key, {
      ...current,
      entries: merge(current.entries, entries),
    });
  }
}

async function load(
  roomId: string,
  tabId: string,
  agentKey: string | null,
  older: boolean,
) {
  const key = keyOf(tabId, agentKey);
  const current = transcripts.get(key) ?? emptyTranscript;
  if (current.loading || (!older && current.loaded)) return;
  if (older && current.nextSeq === null) return;
  set(transcripts, key, { ...current, loading: true, error: null });
  try {
    const result = await window.desktop.loadTranscript(
      roomId,
      tabId,
      older ? (current.nextSeq ?? undefined) : undefined,
      agentKey ?? undefined,
    );
    const latest = transcripts.get(key) ?? emptyTranscript;
    if (!result.ok || !result.transcript) {
      set(transcripts, key, {
        ...latest,
        loading: false,
        error: result.ok ? "The transcript could not be loaded." : result.error,
      });
      return;
    }
    const page = result.transcript;
    set(transcripts, key, {
      entries: merge(page.entries, latest.entries),
      // Paging back from the first page sets where older history starts.
      nextSeq: older || !latest.loaded ? page.nextSeq : latest.nextSeq,
      loaded: true,
      loading: false,
      error: null,
    });
  } catch {
    set(transcripts, key, {
      ...(transcripts.get(key) ?? emptyTranscript),
      loading: false,
      error: "The transcript could not be loaded.",
    });
  }
}

async function loadAgents(roomId: string, tabId: string) {
  const current = agents.get(tabId) ?? emptyAgents;
  if (current.loading || current.loaded) return;
  set(agents, tabId, { ...current, loading: true, error: null });
  try {
    const result = await window.desktop.loadAgents(roomId, tabId);
    const latest = agents.get(tabId) ?? emptyAgents;
    set(
      agents,
      tabId,
      result.ok && result.transcript
        ? {
            cards: merge(
              result.transcript.entries.filter(isAgent),
              latest.cards,
            ),
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
    set(agents, tabId, {
      ...(agents.get(tabId) ?? emptyAgents),
      loading: false,
      error: "Sub-agents could not be loaded.",
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
  const transcript = useSyncExternalStore(subscribe, () =>
    tabId
      ? (transcripts.get(keyOf(tabId, agentKey)) ?? emptyTranscript)
      : emptyTranscript,
  );
  useEffect(() => {
    if (tabId) void load(roomId, tabId, agentKey, false);
  }, [roomId, tabId, agentKey]);
  return transcript;
}

/** A tab's sub-agent cards, loading them on first view; `loaded` is false until they arrive. */
export function useAgents(roomId: string, tabId: string | null) {
  const state = useSyncExternalStore(subscribe, () =>
    tabId ? (agents.get(tabId) ?? emptyAgents) : emptyAgents,
  );
  useEffect(() => {
    if (tabId) void loadAgents(roomId, tabId);
  }, [roomId, tabId]);
  return state;
}

export function connectTranscripts() {
  if (!window.desktop) return () => {};
  return window.desktop.onTranscript(acceptTranscript);
}
