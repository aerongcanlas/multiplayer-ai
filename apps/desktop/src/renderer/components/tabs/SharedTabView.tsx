import { Eye } from "lucide-react";
import { useEffect } from "react";
import type { SharedTab } from "../../../shared/collaboration";
import { HARNESS_LABELS } from "../../../shared/tabs";
import {
  ageLabel,
  asTranscriptEntry,
  SHARED_STATUS_LABELS,
  useNow,
} from "../../lib/read-along";
import {
  loadEarlierShared,
  useSharedTranscript,
} from "../../lib/transcript-store";
import { ReadOnlyTranscript } from "./TranscriptView";

const LEAVE_AFTER_MS = 2_500;

/**
 * Another host's read-along tab: a header with host, harness, status, and age, then the shared
 * transcript. Nothing here can prompt, approve, answer, stop, or change the host's tab.
 */
export function SharedTabView({
  roomId,
  tabId,
  listed,
  connected,
  clockOffsetMs,
  onLeave,
}: {
  roomId: string;
  tabId: string;
  // The tab's row in the room list, or undefined once it left the list.
  listed: SharedTab | undefined;
  connected: boolean;
  clockOffsetMs: number | undefined;
  // Returns selection to the viewer's own tab.
  onLeave: () => void;
}) {
  const transcript = useSharedTranscript(roomId, tabId);
  const now = useNow();
  const record = transcript.record ?? listed ?? null;
  const closed =
    record?.status === "closed" ||
    (!listed && transcript.state !== "loading") ||
    transcript.state === "unshared";
  useEffect(() => {
    if (!closed) return;
    const timer = setTimeout(onLeave, LEAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [closed, onLeave]);
  const entries = transcript.entries.map((entry) =>
    asTranscriptEntry(tabId, entry),
  );
  const live = record?.status === "running";
  return (
    <>
      <div className="drill-header shared-header">
        <Eye size={13} aria-hidden />
        <h3>{record?.title ?? "Shared tab"}</h3>
        {record && (
          <span className={`agent-status shared-status-${record.status}`}>
            {SHARED_STATUS_LABELS[record.status]}
          </span>
        )}
        <span className="subtle">
          {record
            ? `${record.sameUser ? "You on another desktop" : record.hostName} · ${HARNESS_LABELS[record.harness]}${record.model ? ` · ${record.model}` : ""}`
            : ""}
          {record &&
            ` · ${ageLabel(
              record.updatedAt,
              connected && transcript.state !== "reconnecting",
              clockOffsetMs,
              now,
            )}`}
        </span>
        <span className="subtle">Read-only</span>
      </div>
      {closed ? (
        <div className="panel-scroll">
          <p className="subtle transcript-empty" role="status">
            {record?.status === "closed"
              ? "The host closed this tab."
              : "This tab is no longer shared."}
          </p>
        </div>
      ) : transcript.state === "failed" && !entries.length ? (
        <div className="panel-scroll">
          <p className="inline-warning" role="alert">
            This shared tab could not be loaded. It retries on the next room
            refresh.
          </p>
        </div>
      ) : transcript.state === "loading" && !entries.length ? (
        <div className="panel-scroll">
          <p className="subtle transcript-empty" role="status">
            Loading the shared tab…
          </p>
        </div>
      ) : (
        <>
          {record?.status === "ended" && (
            <p className="read-along-ended" role="status">
              The host turned read-along off. What they shared stays below.
            </p>
          )}
          <ReadOnlyTranscript
            tabId={tabId}
            entries={entries}
            live={live}
            canLoadOlder={transcript.earlierSeq !== null}
            loading={transcript.loadingEarlier}
            onLoadOlder={() => void loadEarlierShared(roomId, tabId)}
            empty={
              <p className="subtle transcript-empty" role="status">
                Nothing shared yet. New messages appear here as the host works.
              </p>
            }
          />
        </>
      )}
    </>
  );
}
