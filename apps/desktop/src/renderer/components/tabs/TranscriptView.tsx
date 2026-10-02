import { Markdown } from "@multiplayer-ai/ui/primitives/markdown";
import { ThreadWelcome } from "@multiplayer-ai/ui/ai/thread-welcome";
import {
  AlertTriangle,
  ChevronsUp,
  ClipboardList,
  Info,
  RotateCcw,
  Terminal,
} from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import {
  HARNESS_LABELS,
  tabBusy,
  type AgentEntry,
  type ApprovalDecision,
  type QuestionAnswers,
  type Tab,
  type TranscriptEntry,
} from "../../../shared/tabs";
import {
  loadOlder,
  useAgents,
  useTranscript,
} from "../../lib/transcript-store";
import { Button } from "../ui/Button";
import { timeLabel } from "../../lib/time";
import { plural } from "../../lib/utils";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";

export interface Actions {
  onRespond: (entry: TranscriptEntry, decision: ApprovalDecision) => void;
  onAnswer: (entry: TranscriptEntry, answers: QuestionAnswers) => void;
  onContinuePlan: () => void;
  onFreshSession: () => void;
}

const resetLabel = (resetsAt: number | null | undefined) =>
  resetsAt
    ? ` Resets ${new Date(resetsAt * 1000).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
      })}.`
    : "";

// Links in someone else's markdown never open a scheme other than http(s).
const peerLinks = {
  enabled: true,
  onLinkCheck: (url: string) => /^https?:\/\//i.test(url),
  renderModal: () => null,
};
const STATE_LABELS: Record<NonNullable<TranscriptEntry["state"]>, string> = {
  pending: "waiting on the host",
  accepted: "approved",
  declined: "declined",
  answered: "answered",
  cancelled: "cancelled",
};

/** Another host's entry: summaries only, no actions, and nothing host-local. */
function ReadOnlyEntry({
  entry,
  streaming,
}: {
  entry: TranscriptEntry;
  streaming: boolean;
}) {
  switch (entry.kind) {
    case "user":
      return (
        <div className="turn-user">
          <p>{entry.summary}</p>
        </div>
      );
    case "assistant":
      return (
        <div className="turn-assistant">
          <Markdown isAnimating={streaming} linkSafety={peerLinks}>
            {entry.summary}
          </Markdown>
        </div>
      );
    case "plan":
      return (
        <div className="turn-plan" role="region" aria-label="Plan">
          <span className="eyebrow">
            <ClipboardList size={12} />
            Plan{entry.state ? ` · ${STATE_LABELS[entry.state]}` : ""}
          </span>
          <Markdown linkSafety={peerLinks}>{entry.summary}</Markdown>
          {entry.detail && (
            <Markdown linkSafety={peerLinks}>{entry.detail}</Markdown>
          )}
        </div>
      );
    case "tool":
      return (
        <div className="turn-tool turn-summary">
          <Terminal size={12} />
          <span>{entry.summary}</span>
        </div>
      );
    case "approval":
      return (
        <div className="turn-notice turn-summary" role="status">
          <Info size={13} />
          <p>
            Approval · {entry.summary}
            {entry.state ? ` · ${STATE_LABELS[entry.state]}` : ""}
          </p>
        </div>
      );
    case "notice":
    case "error":
      return (
        <div className="turn-notice turn-summary" role="status">
          {entry.kind === "error" ? (
            <AlertTriangle size={13} />
          ) : (
            <Info size={13} />
          )}
          <p>{entry.summary}</p>
        </div>
      );
    case "turn":
      return (
        <div className={`turn-end outcome-${entry.outcome ?? "completed"}`}>
          <span>
            {entry.summary} · {timeLabel(entry.updatedAt)}
          </span>
        </div>
      );
    default:
      return null;
  }
}

function Entry({
  entry,
  tab,
  agent,
  latestPlan,
  disabled,
  streaming,
  actions,
}: {
  entry: TranscriptEntry;
  tab: Tab;
  agent?: string;
  latestPlan: boolean;
  disabled: boolean;
  streaming: boolean;
  actions: Actions;
}) {
  switch (entry.kind) {
    case "user":
      return (
        <div className="turn-user">
          <p>{entry.summary}</p>
          {entry.source && (
            <span className="source-chip">
              From a room suggestion ·{" "}
              {plural(entry.source.sources.length, "source message")}
            </span>
          )}
        </div>
      );
    case "assistant":
      return (
        <div className="turn-assistant">
          <Markdown isAnimating={streaming}>{entry.summary}</Markdown>
        </div>
      );
    case "reasoning":
      return (
        <details className="turn-reasoning">
          <summary>Thinking</summary>
          <p>{entry.summary}</p>
        </details>
      );
    case "plan": {
      const canContinue =
        latestPlan &&
        entry.continuable &&
        tab.loadout.planMode &&
        !tabBusy(tab.status);
      return (
        <div className="turn-plan" role="region" aria-label="Plan">
          <span className="eyebrow">
            <ClipboardList size={12} />
            Plan
          </span>
          <Markdown>{entry.summary}</Markdown>
          {entry.state === "pending" ? (
            <div className="card-actions">
              <Button
                size="xs"
                disabled={disabled}
                onClick={() => actions.onRespond(entry, "accept")}
              >
                Continue into execution
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => actions.onRespond(entry, "decline")}
              >
                Keep planning
              </Button>
            </div>
          ) : canContinue ? (
            <div className="card-actions">
              <Button
                size="xs"
                disabled={disabled}
                onClick={actions.onContinuePlan}
              >
                Continue into execution
              </Button>
            </div>
          ) : null}
        </div>
      );
    }
    case "tool":
      return (
        <details className="turn-tool">
          <summary>
            <Terminal size={12} />
            <span>{entry.summary}</span>
          </summary>
          {/* Tool output is plain text; nothing from it is rendered as markup. */}
          {entry.detail ? (
            <pre>{entry.detail}</pre>
          ) : (
            <p className="subtle">No output.</p>
          )}
        </details>
      );
    case "approval":
      return (
        <ApprovalCard
          entry={entry}
          agent={agent}
          disabled={disabled}
          onRespond={(decision) => actions.onRespond(entry, decision)}
        />
      );
    case "question":
      return (
        <QuestionCard
          entry={entry}
          agent={agent}
          disabled={disabled}
          onAnswer={(answers) => actions.onAnswer(entry, answers)}
        />
      );
    case "notice":
    case "error":
      return (
        <div
          className={`turn-notice notice-${entry.kind} ${entry.notice ? `notice-${entry.notice}` : ""}`}
          role={entry.kind === "error" ? "alert" : "status"}
        >
          {entry.kind === "error" ? (
            <AlertTriangle size={13} />
          ) : (
            <Info size={13} />
          )}
          <p>
            {entry.summary}
            {entry.notice === "usage_limit" && resetLabel(entry.resetsAt)}
            {entry.notice === "signed_out" &&
              " Harness settings are in the sidebar."}
          </p>
          {entry.offerFreshSession && (
            <Button
              size="xs"
              variant="outline"
              disabled={disabled || tabBusy(tab.status)}
              onClick={actions.onFreshSession}
            >
              <RotateCcw size={12} />
              Start fresh session
            </Button>
          )}
        </div>
      );
    case "turn":
      return (
        <div className={`turn-end outcome-${entry.outcome ?? "completed"}`}>
          <span>
            {entry.summary} · {timeLabel(entry.createdAt)}
          </span>
        </div>
      );
  }
}

/** The scrolling transcript frame: sticks to the bottom as text streams, pages back on request. */
function TranscriptScroll({
  resetKey,
  canLoadOlder,
  loading,
  error,
  onLoadOlder,
  children,
}: {
  resetKey: string;
  canLoadOlder: boolean;
  loading: boolean;
  error: string | null;
  onLoadOlder: () => void;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Scroll position lives in a ref and follows layout changes, not effects on state.
  const stuckToBottom = useRef(true);
  useEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;
    const observer = new ResizeObserver(() => {
      if (stuckToBottom.current) scroll.scrollTop = scroll.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [resetKey]);
  return (
    <div
      className="panel-scroll transcript"
      ref={scrollRef}
      onScroll={(event) => {
        const node = event.currentTarget;
        stuckToBottom.current =
          node.scrollHeight - node.scrollTop - node.clientHeight <= 40;
      }}
    >
      <div ref={contentRef} className="transcript-content">
        {canLoadOlder && (
          <Button
            size="xs"
            variant="ghost"
            className="transcript-older"
            disabled={loading}
            onClick={onLoadOlder}
          >
            <ChevronsUp size={12} />
            Load earlier messages
          </Button>
        )}
        {error && <p className="inline-warning">{error}</p>}
        {children}
      </div>
    </div>
  );
}

/** Another host's shared entries, read-only: no controls, banners, or raw markup. */
export function ReadOnlyTranscript({
  tabId,
  entries,
  live,
  canLoadOlder,
  loading,
  onLoadOlder,
  empty,
}: {
  tabId: string;
  entries: TranscriptEntry[];
  // The last assistant entry is still growing.
  live: boolean;
  canLoadOlder: boolean;
  loading: boolean;
  onLoadOlder: () => void;
  empty: ReactNode;
}) {
  const last = entries.at(-1);
  return (
    <TranscriptScroll
      resetKey={tabId}
      canLoadOlder={canLoadOlder}
      loading={loading}
      error={null}
      onLoadOlder={onLoadOlder}
    >
      {entries.length === 0
        ? empty
        : entries.map((entry) => (
            <ReadOnlyEntry
              key={entry.seq}
              entry={entry}
              streaming={
                live && entry.seq === last?.seq && entry.kind === "assistant"
              }
            />
          ))}
    </TranscriptScroll>
  );
}

/** The lead's transcript, or with `agentKey` one sub-agent's, read-only in the main area. */
export function TranscriptView({
  roomId,
  tab,
  agentKey = null,
  agent,
  disabled,
  actions,
}: {
  roomId: string;
  tab: Tab;
  agentKey?: string | null;
  // The drilled-in sub-agent's card, once loaded.
  agent?: AgentEntry;
  disabled: boolean;
  actions: Actions;
}) {
  const transcript = useTranscript(roomId, tab.id, agentKey);
  const { cards } = useAgents(roomId, tab.id);
  const entries = transcript.entries;
  const latestPlan = agentKey
    ? undefined
    : entries.findLast((entry) => entry.kind === "plan" && !entry.agentKey);
  const last = entries.at(-1);
  const busy = agentKey
    ? agent?.agent.status === "running"
    : tabBusy(tab.status);
  return (
    <TranscriptScroll
      resetKey={`${tab.id}:${agentKey ?? ""}`}
      canLoadOlder={transcript.nextSeq !== null}
      loading={transcript.loading}
      error={transcript.error}
      onLoadOlder={() => loadOlder(roomId, tab.id, agentKey)}
    >
      {transcript.loaded && entries.length === 0 && agentKey ? (
        <p className="subtle transcript-empty">
          This sub-agent has not reported any messages yet.
        </p>
      ) : transcript.loaded && entries.length === 0 ? (
        <ThreadWelcome
          className="h-full py-6"
          description={`Send a message to start a ${HARNESS_LABELS[tab.loadout.harness]} session in this room's repository.`}
        />
      ) : (
        entries.map((entry) => (
          <Entry
            key={entry.id}
            entry={entry}
            tab={tab}
            agent={
              entry.agentKey && !agentKey
                ? (cards.find((card) => card.agent.key === entry.agentKey)
                    ?.summary ?? "a sub-agent")
                : undefined
            }
            latestPlan={entry.id === latestPlan?.id}
            disabled={disabled}
            streaming={
              busy && entry.id === last?.id && entry.kind === "assistant"
            }
            actions={actions}
          />
        ))
      )}
    </TranscriptScroll>
  );
}
