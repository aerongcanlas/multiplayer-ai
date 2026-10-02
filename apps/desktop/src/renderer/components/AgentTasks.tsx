import { GitBranch } from "lucide-react";
import type { SharedAgentEntry } from "../lib/read-along";
import {
  agentCount,
  agentsNotes,
  agentsNotice,
  cardView,
  groupByTurn,
  type MissionSource,
} from "../lib/mission";
import { timeLabel, useNow } from "../lib/time";
import { plural } from "../lib/utils";

function AgentCard({
  card,
  depth,
  selected,
  now,
  source,
  onSelect,
}: {
  card: SharedAgentEntry;
  depth: number;
  selected: boolean;
  now: number;
  source: MissionSource;
  onSelect: () => void;
}) {
  const view = cardView(card, source, now);
  const style = {
    marginLeft: depth * 14,
    width: `calc(100% - ${depth * 14}px)`,
  };
  const body = (
    <>
      <span className="agent-heading">
        <strong>{card.summary}</strong>
        <span className={`agent-status status-${view.status}`}>
          {view.statusLabel}
        </span>
      </span>
      {view.kind && <span className="agent-meta">{view.kind}</span>}
      <span className="agent-meta">
        {view.meta}
        {view.joinedMidRun && (
          <span className="agent-joined"> · Joined mid-run</span>
        )}
      </span>
      {view.summary && <span className="agent-summary">{view.summary}</span>}
    </>
  );
  // A spectator's card is plain content: nothing to select and no transcript to open.
  if (!view.interactive)
    return (
      <div
        className={`agent-card agent-static agent-${view.status}`}
        style={style}
        data-agent-card={card.agent.key}
      >
        {body}
      </div>
    );
  return (
    <button
      type="button"
      className={`agent-card agent-${view.status} ${selected ? "agent-selected" : ""}`}
      style={style}
      data-agent-card={card.agent.key}
      aria-pressed={selected}
      onClick={onSelect}
    >
      {body}
    </button>
  );
}

export function AgentTasks({
  source,
  agentKey,
  onSelectAgent,
}: {
  source: MissionSource | null;
  agentKey: string | null;
  onSelectAgent: (key: string | null) => void;
}) {
  const cards = source?.cards ?? [];
  const live =
    !source?.spectator?.ended &&
    cards.some((card) => card.agent.status === "running");
  const now = useNow(live);
  const count = agentCount(source);
  const notice = agentsNotice(source);
  return (
    <section className="mission-column" aria-label="Agent tasks">
      <h3>
        <GitBranch size={14} />
        Agent tasks
        {source?.spectator?.needsHost && (
          <span className="agent-status shared-status-awaiting_host">
            Needs the host
          </span>
        )}
        {count && <span>{count}</span>}
      </h3>
      <div className="mission-scroll">
        {notice ? (
          <div className="column-empty" role={notice.status && "status"}>
            {notice.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        ) : (
          <>
            {agentsNotes(source).map((note) => (
              <p key={note} className="subtle agent-note" role="status">
                {note}
              </p>
            ))}
            {groupByTurn(cards).map((group, index) => (
              <details
                key={group.turnId}
                className="agent-turn"
                open={index === 0}
              >
                <summary>
                  {index === 0 ? "Latest turn" : "Earlier turn"} ·{" "}
                  {timeLabel(group.first.createdAt)}
                  <span>{plural(group.ordered.length, "agent")}</span>
                </summary>
                {group.ordered.map(({ card, depth }) => (
                  <AgentCard
                    key={card.id}
                    card={card}
                    depth={depth}
                    now={now}
                    source={source!}
                    selected={card.agent.key === agentKey}
                    onSelect={() =>
                      onSelectAgent(
                        card.agent.key === agentKey ? null : card.agent.key,
                      )
                    }
                  />
                ))}
              </details>
            ))}
          </>
        )}
      </div>
    </section>
  );
}
