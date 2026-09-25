import {
  CheckCircle2,
  Circle,
  CircleDot,
  ClipboardList,
  GitBranch,
  Pencil,
  Radio,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { Room, Suggestion } from "../../shared/contracts";
import {
  HARNESS_LABELS,
  type HarnessState,
  type PlanStep,
  type Tab,
  type TranscriptEntry,
} from "../../shared/tabs";
import { Button } from "./ui/Button";
import { durationLabel, timeLabel } from "../lib/time";
import { perform } from "../lib/desktop-store";
import { useAgents } from "../lib/agents-store";
import { AGENT_STATUS_LABELS, STATUS_LABELS } from "./tabs/labels";

const dismissedKey = (roomId: string) => `multiplayer:dismissed:${roomId}`;

/** Suggestions hidden on this desktop only; the room keeps them for everyone else. */
function useDismissed(roomId: string) {
  const [ids, setIds] = useState<Set<string>>(() => {
    try {
      return new Set(
        JSON.parse(localStorage.getItem(dismissedKey(roomId)) ?? "[]"),
      );
    } catch {
      return new Set();
    }
  });
  function update(next: Set<string>) {
    setIds(next);
    localStorage.setItem(dismissedKey(roomId), JSON.stringify([...next]));
  }
  return {
    ids,
    dismiss: (id: string) => update(new Set(ids).add(id)),
    restore: (id: string) => {
      const next = new Set(ids);
      next.delete(id);
      update(next);
    },
  };
}

function SuggestionCard({
  suggestion,
  roomId,
  disabled,
  canEdit,
  dismissed,
  onUse,
  onDismiss,
  onRestore,
}: {
  suggestion: Suggestion;
  roomId: string;
  disabled: boolean;
  canEdit: boolean;
  dismissed: boolean;
  onUse: (suggestion: Suggestion) => void;
  onDismiss: () => void;
  onRestore: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(suggestion.prompt);
  const submitted = suggestion.status === "submitted";
  async function save() {
    const result = await perform(() =>
      window.desktop.editSuggestion(
        roomId,
        suggestion.id,
        draft,
        suggestion.revision,
      ),
    );
    if (result) setEditing(false);
  }
  return (
    <article
      className={`suggestion-card ${dismissed ? "suggestion-dismissed" : ""}`}
    >
      <div className="card-meta">
        <span>Edit {suggestion.revision}</span>
        <span>
          {dismissed ? "Dismissed" : submitted ? "Submitted" : "Draft"}
        </span>
      </div>
      {editing ? (
        <textarea
          className="suggestion-editor"
          aria-label="Edit suggested prompt"
          maxLength={8_000}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      ) : (
        <p className="suggestion-prompt">{suggestion.prompt}</p>
      )}
      <details className="source-details">
        <summary>
          {suggestion.sources.length} attributed source{" "}
          {suggestion.sources.length === 1 ? "message" : "messages"}
        </summary>
        {suggestion.sources.map((source) => (
          <blockquote key={source.id}>
            <strong>{source.authorName}</strong>
            <p>{source.text}</p>
            <span>{timeLabel(source.createdAt)}</span>
          </blockquote>
        ))}
      </details>
      <div className="card-actions">
        {dismissed ? (
          <Button size="xs" variant="outline" onClick={onRestore}>
            <RotateCcw size={12} />
            Restore
          </Button>
        ) : editing ? (
          <>
            <Button
              size="xs"
              disabled={disabled || !draft.trim()}
              onClick={() => void save()}
            >
              Save edit
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setDraft(suggestion.prompt);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              size="xs"
              disabled={disabled || submitted}
              onClick={() => onUse(suggestion)}
            >
              Use prompt
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled || submitted || !canEdit}
              onClick={() => setEditing(true)}
            >
              <Pencil size={12} />
              Edit
            </Button>
            <Button size="xs" variant="ghost" onClick={onDismiss}>
              Dismiss
            </Button>
          </>
        )}
      </div>
    </article>
  );
}

const STEP_ICONS: Record<PlanStep["status"], typeof Circle> = {
  pending: Circle,
  active: CircleDot,
  done: CheckCircle2,
};
const STEP_LABELS: Record<PlanStep["status"], string> = {
  pending: "Pending",
  active: "In progress",
  done: "Done",
};

function LeadContext({
  tab,
  harness,
}: {
  tab: Tab | undefined;
  harness: HarnessState | undefined;
}) {
  const model =
    harness?.models.find((item) => item.id === tab?.loadout.model)?.name ??
    tab?.loadout.model;
  const steps = tab?.plan?.steps ?? [];
  return (
    <section className="mission-column" aria-label="Lead context">
      <h3>
        <ClipboardList size={14} />
        Lead context{tab && <span>{STATUS_LABELS[tab.status]}</span>}
      </h3>
      <div className="mission-scroll">
        {!tab ? (
          <div className="column-empty">
            <p>Open a chat tab to follow its lead here.</p>
          </div>
        ) : (
          <div className="summary-content">
            <dl className="lead-facts">
              <div>
                <dt>Harness</dt>
                <dd>{HARNESS_LABELS[tab.loadout.harness]}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{model || "Not chosen"}</dd>
              </div>
              <div>
                <dt>Mode</dt>
                <dd>{tab.loadout.planMode ? "Plan" : "Act"}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{STATUS_LABELS[tab.status]}</dd>
              </div>
            </dl>
            <span className="eyebrow">Plan</span>
            {steps.length ? (
              <>
                {tab.plan?.explanation && <p>{tab.plan.explanation}</p>}
                <ol className="lead-steps" aria-label="Lead plan">
                  {steps.map((step, index) => {
                    const Icon = STEP_ICONS[step.status];
                    return (
                      <li key={index} className={`step-${step.status}`}>
                        <Icon size={12} aria-label={STEP_LABELS[step.status]} />
                        <span>{step.text}</span>
                      </li>
                    );
                  })}
                </ol>
              </>
            ) : (
              <p className="subtle">
                No plan in this tab. {HARNESS_LABELS[tab.loadout.harness]} shows
                its plan here when it keeps one.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** A clock that ticks every second while `active`, for running cards' elapsed time. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** A turn's cards, newest turn first, each card followed by the sub-agents it spawned. */
function groupByTurn(cards: TranscriptEntry[]) {
  const turns = new Map<string, TranscriptEntry[]>();
  for (const card of cards)
    turns.set(card.turnId ?? "", [
      ...(turns.get(card.turnId ?? "") ?? []),
      card,
    ]);
  return [...turns.entries()]
    .map(([turnId, items]) => {
      const keys = new Set(items.map((card) => card.agent!.key));
      const ordered: { card: TranscriptEntry; depth: number }[] = [];
      const walk = (card: TranscriptEntry, depth: number) => {
        ordered.push({ card, depth });
        for (const child of items.filter(
          (item) => item.agent!.parentKey === card.agent!.key,
        ))
          walk(child, depth + 1);
      };
      for (const root of items.filter(
        (card) => !card.agent!.parentKey || !keys.has(card.agent!.parentKey),
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
  card: TranscriptEntry;
  depth: number;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  const agent = card.agent!;
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
        {elapsed} · {agent.toolUses} tool{agent.toolUses === 1 ? "" : "s"}
        {running && agent.latestTool ? ` · ${agent.latestTool}` : ""}
      </span>
      {!running && card.detail && (
        <span className="agent-summary">{card.detail}</span>
      )}
    </button>
  );
}

function AgentTasks({
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
    (card) => card.agent?.status === "running",
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
                <span>
                  {group.ordered.length} agent
                  {group.ordered.length === 1 ? "" : "s"}
                </span>
              </summary>
              {group.ordered.map(({ card, depth }) => (
                <AgentCard
                  key={card.id}
                  card={card}
                  depth={depth}
                  now={now}
                  selected={card.agent!.key === agentKey}
                  onSelect={() =>
                    onSelectAgent(
                      card.agent!.key === agentKey ? null : card.agent!.key,
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

export function MissionControlPanel({
  room,
  tab,
  harness,
  agentKey,
  onSelectAgent,
  onUseSuggestion,
  disabled,
}: {
  room: Room;
  tab: Tab | undefined;
  harness: HarnessState | undefined;
  agentKey: string | null;
  onSelectAgent: (key: string | null) => void;
  onUseSuggestion: (suggestion: Suggestion) => void;
  disabled: boolean;
}) {
  const running = tab?.runningAgents ?? 0;
  return (
    <section className="mission-panel" aria-label="Mission Control">
      <header className="panel-header">
        <h2>
          <Radio size={16} />
          Mission Control
        </h2>
        <span className="subtle">
          {tab
            ? `${tab.title}${running ? ` · ${running} sub-agent${running === 1 ? "" : "s"} running` : ""}`
            : "Follows the active chat tab"}
        </span>
      </header>
      <div className="mission-grid">
        <LeadContext tab={tab} harness={harness} />
        <AgentTasks
          roomId={room.id}
          tab={tab}
          harness={harness}
          agentKey={agentKey}
          onSelectAgent={onSelectAgent}
        />
        <SuggestionColumn
          room={room}
          disabled={disabled}
          onUseSuggestion={onUseSuggestion}
        />
      </div>
    </section>
  );
}

function SuggestionColumn({
  room,
  disabled,
  onUseSuggestion,
}: {
  room: Room;
  disabled: boolean;
  onUseSuggestion: (suggestion: Suggestion) => void;
}) {
  const { ids, dismiss, restore } = useDismissed(room.id);
  const [showDismissed, setShowDismissed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const all = [...room.suggestions].reverse();
  const visible = all.filter((item) => !ids.has(item.id));
  const hidden = all.filter((item) => ids.has(item.id));
  const shown = showDismissed ? [...visible, ...hidden] : visible;
  return (
    <section className="mission-column" aria-label="Prompt suggestions">
      <h3>
        <Sparkles size={14} />
        Prompt suggestions<span>{visible.length}</span>
      </h3>
      <p className="sr-only" role="status">
        {announcement}
      </p>
      <div className="mission-scroll">
        {visible.length === 0 && !showDismissed ? (
          <div className="column-empty">
            {hidden.length > 0 ? (
              <p>All suggestions are dismissed.</p>
            ) : (
              <>
                <p>
                  Select messages in Group Chat, then choose{" "}
                  <strong>Suggest prompts</strong>.
                </p>
                <p>
                  Edit the draft and choose <strong>Use prompt</strong> to fill
                  the active tab. Send it when you’re ready.
                </p>
              </>
            )}
          </div>
        ) : (
          shown.map((suggestion) => (
            <SuggestionCard
              key={`${suggestion.id}:${suggestion.revision}`}
              suggestion={suggestion}
              roomId={room.id}
              canEdit={
                !room.shared ||
                room.shared.isAdmin ||
                suggestion.authorId === room.shared.userId
              }
              disabled={disabled}
              dismissed={ids.has(suggestion.id)}
              onUse={onUseSuggestion}
              onDismiss={() => {
                dismiss(suggestion.id);
                setAnnouncement("Suggestion dismissed.");
              }}
              onRestore={() => {
                restore(suggestion.id);
                setAnnouncement("Suggestion restored.");
              }}
            />
          ))
        )}
        {hidden.length > 0 && (
          <Button
            size="xs"
            variant="ghost"
            className="suggestion-toggle"
            aria-expanded={showDismissed}
            onClick={() => setShowDismissed(!showDismissed)}
          >
            {showDismissed
              ? "Hide dismissed"
              : `Show ${hidden.length} dismissed`}
          </Button>
        )}
      </div>
    </section>
  );
}
