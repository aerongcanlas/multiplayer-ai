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
import { useEffect, useRef } from "react";
import {
  HARNESS_LABELS,
  tabBusy,
  type Tab,
  type TranscriptEntry,
} from "../../../shared/tabs";
import { loadOlder, useTranscript } from "../../lib/transcript-store";
import { useAgents } from "../../lib/agents-store";
import { Button } from "../ui/Button";
import { timeLabel } from "../../lib/time";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";

interface Actions {
  onRespond: (entry: TranscriptEntry, decision: "accept" | "decline") => void;
  onAnswer: (entry: TranscriptEntry, answers: Record<string, string[]>) => void;
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
              From a room suggestion · {entry.source.sources.length} source{" "}
              {entry.source.sources.length === 1 ? "message" : "messages"}
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

/** The lead's transcript, or with `agentKey` one sub-agent's, read-only in the main area. */
export function TranscriptView({
  roomId,
  tab,
  agentKey = null,
  disabled,
  actions,
}: {
  roomId: string;
  tab: Tab;
  agentKey?: string | null;
  disabled: boolean;
  actions: Actions;
}) {
  const transcript = useTranscript(roomId, tab.id, agentKey);
  const { cards } = useAgents(roomId, tab.id);
  const card = (key: string) => cards.find((item) => item.agent?.key === key);
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
  }, [tab.id, agentKey]);
  const entries = transcript.entries;
  const latestPlan = agentKey
    ? undefined
    : entries.findLast((entry) => entry.kind === "plan" && !entry.agentKey);
  const last = entries.at(-1);
  const busy = agentKey
    ? card(agentKey)?.agent?.status === "running"
    : tabBusy(tab.status);
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
        {transcript.nextSeq !== null && (
          <Button
            size="xs"
            variant="ghost"
            className="transcript-older"
            disabled={transcript.loading}
            onClick={() => loadOlder(roomId, tab.id, agentKey)}
          >
            <ChevronsUp size={12} />
            Load earlier messages
          </Button>
        )}
        {transcript.error && (
          <p className="inline-warning">{transcript.error}</p>
        )}
        {transcript.loaded && entries.length === 0 && agentKey ? (
          <p className="subtle transcript-empty">
            This sub-agent has not reported any messages yet.
          </p>
        ) : transcript.loaded && entries.length === 0 ? (
          <ThreadWelcome
            className="h-full py-6"
            description={`Send a message to start a ${HARNESS_LABELS[tab.loadout.harness]} session in this room's repository.`}
          >
            <span className="subtle">
              Your {HARNESS_LABELS[tab.loadout.harness]} skills, plugins, and
              instructions load as they do in its own terminal.
            </span>
          </ThreadWelcome>
        ) : (
          entries.map((entry) => (
            <Entry
              key={entry.id}
              entry={entry}
              tab={tab}
              agent={
                entry.agentKey && !agentKey
                  ? (card(entry.agentKey)?.summary ?? "a sub-agent")
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
      </div>
    </div>
  );
}
