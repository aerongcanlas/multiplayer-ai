import { useEffect, useSyncExternalStore } from "react";
import type {
  SharedEntry,
  SharedPlan,
  SharedTab,
  SharedTranscriptMessage,
} from "../../shared/collaboration";
import { asAgentEntry, type SharedAgentEntry } from "./read-along";
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

// Another host's read-along tab, keyed `shared:<tabId>` apart from this desktop's own tabs.
export interface SharedTranscript {
  // The lead's entries; sub-agent cards are held apart in `cards`.
  entries: SharedEntry[];
  cards: SharedEntry[];
  // Set once main's cards load answers: all cards, the latest ones, or none available.
  cardsState?: "ready" | "capped" | "unavailable";
  record: SharedTab | null;
  state: Extract<SharedTranscriptMessage, { type: "status" }>["state"];
  // The seq to page back from, or null once the start is loaded.
  earlierSeq: number | null;
  loadingEarlier: boolean;
}
const emptyShared: SharedTranscript = {
  entries: [],
  cards: [],
  record: null,
  state: "loading",
  earlierSeq: null,
  loadingEarlier: false,
};
const shared = new Map<string, SharedTranscript>();
const sharedKey = (tabId: string) => `shared:${tabId}`;

/** Merges by seq, keeping the higher version, so a delayed older publish never regresses text. */
function mergeShared(current: SharedEntry[], incoming: SharedEntry[]) {
  const bySeq = new Map(current.map((entry) => [entry.seq, entry]));
  for (const entry of incoming) {
    const held = bySeq.get(entry.seq);
    if (!held || entry.version >= held.version) bySeq.set(entry.seq, entry);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function acceptShared(message: SharedTranscriptMessage) {
  if (message.type === "clear") {
    shared.clear();
    for (const listener of listeners) listener();
    return;
  }
  const key = sharedKey(message.tabId);
  const current = shared.get(key) ?? emptyShared;
  if (message.type === "status") {
    set(shared, key, { ...current, state: message.state });
    return;
  }
  if (message.type === "cards") {
    set(shared, key, {
      ...current,
      cards: mergeShared(current.cards, message.cards),
      ...(message.state ? { cardsState: message.state } : {}),
    });
    return;
  }
  set(shared, key, {
    ...current,
    entries: mergeShared(
      current.entries,
      message.entries.filter((entry) => entry.kind !== "agent"),
    ),
    record: message.record,
    ...(message.earlierSeq !== undefined
      ? { earlierSeq: message.earlierSeq, loadingEarlier: false }
      : {}),
  });
}

export const sharedTranscript = (tabId: string) =>
  shared.get(sharedKey(tabId)) ?? emptyShared;

// What Mission Control shows for a watched tab's sub-agents.
export type SharedAgentsAvailability =
  // The record or the cards have not arrived yet.
  | "loading"
  | "ready"
  // The host's app, or the shared database, predates sub-agent sharing.
  | "unsupported_host"
  // The host's harness does not report sub-agents.
  | "no_reporting";
export interface SharedAgents {
  // The newest record pulled for the tab.
  record: SharedTab | null;
  // Cards in the host's own shape, oldest first.
  cards: SharedAgentEntry[];
  plan: SharedPlan | null;
  runningAgents: number;
  availability: SharedAgentsAvailability;
  // Only the latest cards were loaded.
  capped: boolean;
}
const emptySharedAgents: SharedAgents = {
  record: null,
  cards: [],
  plan: null,
  runningAgents: 0,
  availability: "loading",
  capped: false,
};
// One derived value per stored transcript, so the hook's snapshot stays stable.
const derived = new WeakMap<SharedTranscript, SharedAgents>();

/** A watched tab's cards, plan, and whether its host shares sub-agents at all. */
export function sharedAgents(tabId: string | null): SharedAgents {
  const held = tabId ? shared.get(sharedKey(tabId)) : undefined;
  if (!tabId || !held) return emptySharedAgents;
  const known = derived.get(held);
  if (known) return known;
  const { record, cardsState } = held;
  const value: SharedAgents = {
    record,
    cards: held.cards.flatMap((entry) => asAgentEntry(tabId, entry) ?? []),
    plan: record?.plan ?? null,
    runningAgents: record?.runningAgents ?? 0,
    availability:
      cardsState === "unavailable" ||
      (record && typeof record.reportsAgents !== "boolean")
        ? "unsupported_host"
        : !record || !cardsState
          ? "loading"
          : record.reportsAgents
            ? "ready"
            : "no_reporting",
    capped: cardsState === "capped",
  };
  derived.set(held, value);
  return value;
}

/** The watched shared tab's sub-agents; the shared tab's view does the watching. */
export function useSharedAgents(tabId: string | null) {
  return useSyncExternalStore(subscribe, () => sharedAgents(tabId));
}

export async function loadEarlierShared(roomId: string, tabId: string) {
  const key = sharedKey(tabId);
  const current = sharedTranscript(tabId);
  if (current.earlierSeq === null || current.loadingEarlier) return;
  set(shared, key, { ...current, loadingEarlier: true });
  const result = await window.desktop.loadSharedTranscript(
    roomId,
    tabId,
    current.earlierSeq,
  );
  if (!result.ok)
    set(shared, key, { ...sharedTranscript(tabId), loadingEarlier: false });
}

/** Watches one shared tab while mounted; its entries arrive from main. */
export function useSharedTranscript(roomId: string, tabId: string) {
  const transcript = useSyncExternalStore(subscribe, () =>
    sharedTranscript(tabId),
  );
  useEffect(() => {
    void window.desktop.watchSharedTab(roomId, tabId).then((result) => {
      if (!result.ok)
        acceptShared({ type: "status", roomId, tabId, state: "unshared" });
    });
    return () => void window.desktop.unwatchSharedTab();
  }, [roomId, tabId]);
  return transcript;
}

export function connectTranscripts() {
  if (!window.desktop) return () => {};
  const local = window.desktop.onTranscript(acceptTranscript);
  const remote = window.desktop.onSharedTranscript(acceptShared);
  return () => {
    local();
    remote();
  };
}
