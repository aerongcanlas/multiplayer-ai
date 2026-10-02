import type {
  ReadAlongStatus,
  SharedEntry,
  SharedTab,
  SharedTabStatus,
} from "../../shared/collaboration";
import type { AgentEntry, TranscriptEntry } from "../../shared/tabs";
import { durationLabel } from "./time";

export const SHARED_STATUS_LABELS: Record<SharedTabStatus, string> = {
  running: "Live",
  awaiting_host: "Waiting on the host",
  idle: "Idle",
  interrupted: "Interrupted",
  ended: "Ended",
  closed: "Closed",
};

/** "Updated 42s ago" from server time, or reconnecting while this desktop is offline. */
export function ageLabel(
  updatedAt: string,
  connected: boolean,
  clockOffsetMs = 0,
  now = Date.now(),
) {
  if (!connected) return "Reconnecting…";
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(updated)) return "";
  return `Updated ${durationLabel(now + clockOffsetMs - updated)} ago`;
}

export interface SharedGroup {
  key: string;
  label: string;
  tabs: SharedTab[];
}
/** One group per other host, or per other desktop of this account, in first-seen order. */
export function sharedGroups(tabs: SharedTab[]): SharedGroup[] {
  const groups = new Map<string, SharedGroup>();
  for (const tab of tabs) {
    const key = tab.sameUser ? `${tab.hostId}:${tab.deviceId}` : tab.hostId;
    const group = groups.get(key) ?? {
      key,
      label: tab.sameUser ? "You · another desktop" : tab.hostName,
      tabs: [],
    };
    group.tabs.push(tab);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** A shared entry in the transcript view's shape; message text replaces the one-line summary. */
export const asTranscriptEntry = (
  tabId: string,
  entry: SharedEntry,
): TranscriptEntry => ({
  id: `shared:${tabId}:${entry.seq}`,
  tabId,
  seq: entry.seq,
  turnId: null,
  kind: entry.kind,
  share: entry.share,
  summary: entry.text ?? entry.summary,
  ...(entry.detail ? { detail: entry.detail } : {}),
  ...(entry.state ? { state: entry.state } : {}),
  ...(entry.outcome ? { outcome: entry.outcome } : {}),
  createdAt: entry.updatedAt,
  updatedAt: entry.updatedAt,
});

// A host's card in this desktop's card shape, plus whether it joined mid-run.
export type SharedAgentEntry = AgentEntry & { joinedMidRun?: boolean };

/** A shared card as the host's own card entry: the text is its final summary. */
export function asAgentEntry(
  tabId: string,
  entry: SharedEntry,
): SharedAgentEntry | null {
  if (!entry.agent) return null;
  const { joinedMidRun, turnId, ...agent } = entry.agent;
  return {
    id: `shared:${tabId}:${entry.seq}`,
    tabId,
    seq: entry.seq,
    turnId: turnId ?? null,
    kind: "agent",
    share: "full",
    summary: entry.summary,
    ...(entry.text ? { detail: entry.text } : {}),
    agent,
    ...(joinedMidRun ? { joinedMidRun } : {}),
    createdAt: entry.agent.startedAt,
    updatedAt: entry.updatedAt,
  };
}

/** The host's switch caption. */
export function switchCaption(
  status: ReadAlongStatus | undefined,
  on: boolean,
) {
  if (status?.state === "stopped")
    return status.reason === "not_member"
      ? "Stopped · you are no longer a member of this room"
      : "Stopped · the shared database needs the read-along migration";
  if (!on) return "Off · this tab is private";
  if (status?.state === "paused")
    return `Paused · ${status.buffered} waiting to publish`;
  return "Publishing";
}
