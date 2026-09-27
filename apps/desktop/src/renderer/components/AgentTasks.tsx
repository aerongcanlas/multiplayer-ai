import { GitBranch } from "lucide-react";
import {
  HARNESS_LABELS,
  type AgentEntry,
  type HarnessState,
  type Tab,
} from "../../shared/tabs";
import { durationLabel, timeLabel, useNow } from "../lib/time";
import { useAgents } from "../lib/transcript-store";
import { plural } from "../lib/utils";
import { AGENT_STATUS_LABELS } from "./tabs/labels";

/** A turn's cards, newest turn first, each card followed by the sub-agents it spawned. */
function groupByTurn(cards: AgentEntry[]) {
  const turns = new Map<string, AgentEntry[]>();
  for (const card of cards)
    turns.set(card.turnId ?? "", [
      ...(turns.get(card.turnId ?? "") ?? []),
      card,
    ]);
  return [...turns.entries()]
    .map(([turnId, items]) => {
      const keys = new Set(items.map((card) => card.agent.key));
      const ordered: { card: AgentEntry; depth: number }[] = [];
      const walk = (card: AgentEntry, depth: number) => {
        ordered.push({ card, depth });
        for (const child of items.filter(
          (item) => item.agent.parentKey === card.agent.key,
        ))
          walk(child, depth + 1);
      };
      for (const root of items.filter(
        (card) => !card.agent.parentKey || !keys.has(card.agent.parentKey),
      ))
        walk(root, 0);
      return { turnId, first: items[0], ordered };
    })
    .sort((a, b) => b.first.seq - a.first.seq);
}

function AgentCard({
  card,
  depth,
  selected,
  now,
  onSelect,
}: {
  card: AgentEntry;
  depth: number;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  const { agent } = card;
  const running = agent.status === "running";
  const elapsed = durationLabel(
    (agent.endedAt ? Date.parse(agent.endedAt) : now) -
      Date.parse(agent.startedAt),
  );
  const kind = [agent.name, agent.type].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      className={`agent-card agent-${agent.status} ${selected ? "agent-selected" : ""}`}
      style={{
        marginLeft: depth * 14,
        width: `calc(100% - ${depth * 14}px)`,
      }}
      data-agent-card={agent.key}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="agent-heading">
        <strong>{card.summary}</strong>
        <span className={`agent-status status-${agent.status}`}>
          {AGENT_STATUS_LABELS[agent.status]}
        </span>
      </span>
      {kind && <span className="agent-meta">{kind}</span>}
      <span className="agent-meta">
        {elapsed} · {plural(agent.toolUses, "tool")}
        {running && agent.latestTool ? ` · ${agent.latestTool}` : ""}
      </span>
      {!running && card.detail && (
        <span className="agent-summary">{card.detail}</span>
      )}
    </button>
  );
}

export function AgentTasks({
  roomId,
  tab,
  harness,
  agentKey,
  onSelectAgent,
}: {
  roomId: string;
  tab: Tab | undefined;
  harness: HarnessState | undefined;
  agentKey: string | null;
  onSelectAgent: (key: string | null) => void;
}) {
  const agents = useAgents(roomId, tab?.id ?? null);
  const running = agents.cards.filter(
    (card) => card.agent.status === "running",
  ).length;
  const now = useNow(running > 0);
  const label = tab ? HARNESS_LABELS[tab.loadout.harness] : "";
  const groups = groupByTurn(agents.cards);
  return (
    <section className="mission-column" aria-label="Agent tasks">
      <h3>
        <GitBranch size={14} />
        Agent tasks
        {agents.cards.length > 0 && (
          <span>
            {running ? `${running} running · ` : ""}
            {agents.cards.length}
          </span>
        )}
      </h3>
      <div className="mission-scroll">
        {!tab ? (
          <div className="column-empty">
            <p>Open a chat tab to track the sub-agents it spawns.</p>
          </div>
        ) : harness && !harness.reportsAgents ? (
          <div className="column-empty">
            <p>
              {label} doesn&apos;t report sub-agents, so this tab has none to
              track.
            </p>
          </div>
        ) : !agents.loaded ? (
          <div className="column-empty" role="status">
            <p>{agents.error ?? "Loading sub-agents…"}</p>
          </div>
        ) : groups.length === 0 ? (
          <div className="column-empty">
            <p>No sub-agents in this tab yet.</p>
            <p>
              When {label} spawns sub-agents, they appear here grouped by turn.
              Select one to read its transcript.
            </p>
          </div>
        ) : (
          groups.map((group, index) => (
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
                  selected={card.agent.key === agentKey}
                  onSelect={() =>
                    onSelectAgent(
                      card.agent.key === agentKey ? null : card.agent.key,
                    )
                  }
                />
              ))}
            </details>
          ))
        )}
      </div>
    </section>
  );
}
