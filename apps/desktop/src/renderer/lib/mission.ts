import type { SharedTab } from "../../shared/collaboration";
import {
  HARNESS_LABELS,
  type AgentStatus,
  type HarnessId,
  type HarnessState,
  type PlanStep,
  type Tab,
} from "../../shared/tabs";
import { AGENT_STATUS_LABELS, STATUS_LABELS } from "../components/tabs/labels";
import { SHARED_STATUS_LABELS, type SharedAgentEntry } from "./read-along";
import { durationLabel } from "./time";
import type { SharedAgents } from "./transcript-store";
import { plural } from "./utils";

/**
 * What Mission Control renders for the tab in the main area: the member's own tab, or a host's
 * shared tab, which is view-only.
 */
export interface MissionSource {
  // Set for a host's shared tab.
  spectator?: {
    hostName: string;
    // Read-along is off: the cards are history and no longer update.
    ended: boolean;
    // The host's tab waits on its owner, who alone can answer.
    needsHost: boolean;
    // Only the latest cards were loaded.
    capped: boolean;
  };
  title: string;
  harness: HarnessId;
  status: string;
  facts: { label: string; value: string }[];
  plan: { explanation?: string; steps: Pick<PlanStep, "text" | "status">[] };
  cards: SharedAgentEntry[];
  // Sub-agents running now.
  running: number;
  agents: "loading" | "ready" | "unsupported_host" | "no_reporting";
  error?: string | null;
}

interface OwnAgents {
  cards: SharedAgentEntry[];
  loaded: boolean;
  error: string | null;
}

const isRunning = (card: SharedAgentEntry) => card.agent.status === "running";

function ownSource(
  tab: Tab,
  harness: HarnessState | undefined,
  agents: OwnAgents,
): MissionSource {
  const model =
    harness?.models.find((item) => item.id === tab.loadout.model)?.name ??
    tab.loadout.model;
  return {
    title: tab.title,
    harness: tab.loadout.harness,
    status: STATUS_LABELS[tab.status],
    facts: [
      { label: "Harness", value: HARNESS_LABELS[tab.loadout.harness] },
      { label: "Model", value: model || "Not chosen" },
      { label: "Mode", value: tab.loadout.planMode ? "Plan" : "Act" },
      { label: "Status", value: STATUS_LABELS[tab.status] },
    ],
    plan: {
      ...(tab.plan?.explanation ? { explanation: tab.plan.explanation } : {}),
      steps: tab.plan?.steps ?? [],
    },
    cards: agents.cards,
    running: tab.runningAgents ?? 0,
    agents:
      harness && !harness.reportsAgents
        ? "no_reporting"
        : agents.loaded
          ? "ready"
          : "loading",
    error: agents.error,
  };
}

function spectatorSource(
  record: SharedTab | undefined,
  shared: SharedAgents,
): MissionSource | null {
  if (!record) return null;
  const ended = record.status === "ended" || record.status === "closed";
  const hostName = record.sameUser ? "You on another desktop" : record.hostName;
  return {
    spectator: {
      hostName,
      ended,
      needsHost: record.status === "awaiting_host",
      capped: shared.capped,
    },
    title: record.title,
    harness: record.harness,
    status: SHARED_STATUS_LABELS[record.status],
    facts: [
      { label: "Host", value: hostName },
      { label: "Harness", value: HARNESS_LABELS[record.harness] },
      { label: "Model", value: record.model || "Not chosen" },
      { label: "Status", value: SHARED_STATUS_LABELS[record.status] },
    ],
    plan: shared.plan ?? { steps: [] },
    cards: shared.cards,
    running: ended ? 0 : shared.runningAgents,
    agents: shared.availability,
  };
}

/**
 * The source for the tab in the main area. A shared tab open there wins, so nothing of the
 * member's own tab shows beside a host's data, and none of the host's once they leave it.
 */
export function missionSource(input: {
  tab: Tab | undefined;
  harness: HarnessState | undefined;
  own: OwnAgents;
  // The shared tab filling the main area, if one does.
  watched: { record: SharedTab | undefined; agents: SharedAgents } | null;
}): MissionSource | null {
  if (input.watched)
    return spectatorSource(input.watched.record, input.watched.agents);
  return input.tab ? ownSource(input.tab, input.harness, input.own) : null;
}

/** Mission Control's subtitle: whose tab it follows and what runs there. */
export function missionSubtitle(source: MissionSource | null) {
  if (!source) return "Follows the active chat tab";
  return [
    ...(source.spectator ? [source.spectator.hostName] : []),
    source.title,
    ...(source.running
      ? [`${plural(source.running, "sub-agent")} running`]
      : []),
    ...(source.spectator?.needsHost ? ["needs the host"] : []),
  ].join(" · ");
}

/** The Agent tasks header count: running sub-agents, then every card. */
export function agentCount(source: MissionSource | null) {
  if (!source?.cards.length) return null;
  const running = source.spectator
    ? source.running
    : source.cards.filter(isRunning).length;
  return `${running ? `${running} running · ` : ""}${source.cards.length}`;
}

/** A turn's cards, newest turn first, each card followed by the sub-agents it spawned. */
export function groupByTurn(cards: SharedAgentEntry[]) {
  const turns = new Map<string, SharedAgentEntry[]>();
  for (const card of cards)
    turns.set(card.turnId ?? "", [
      ...(turns.get(card.turnId ?? "") ?? []),
      card,
    ]);
  return [...turns.entries()]
    .map(([turnId, items]) => {
      const keys = new Set(items.map((card) => card.agent.key));
      const ordered: { card: SharedAgentEntry; depth: number }[] = [];
      const walk = (card: SharedAgentEntry, depth: number) => {
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

export interface CardView {
  // A spectator's card is not a control: it selects nothing and opens no transcript.
  interactive: boolean;
  status: AgentStatus;
  statusLabel: string;
  // The sub-agent was already running when the host turned read-along on.
  joinedMidRun: boolean;
  kind: string;
  meta: string;
  // The final summary, once the sub-agent settled.
  summary?: string;
}

/** What one card shows, for the owner or for a spectator. */
export function cardView(
  card: SharedAgentEntry,
  source: Pick<MissionSource, "spectator">,
  now: number,
): CardView {
  const { agent } = card;
  // An ended share stops updating, so a card left running is history, not live work.
  const frozen = Boolean(source.spectator?.ended) && isRunning(card);
  const live = isRunning(card) && !frozen;
  const end = agent.endedAt
    ? Date.parse(agent.endedAt)
    : frozen
      ? Date.parse(card.updatedAt)
      : now;
  return {
    interactive: !source.spectator,
    status: frozen ? "stopped" : agent.status,
    statusLabel: frozen ? "Was running" : AGENT_STATUS_LABELS[agent.status],
    joinedMidRun: Boolean(card.joinedMidRun),
    kind: [agent.name, agent.type].filter(Boolean).join(" · "),
    meta: `${durationLabel(end - Date.parse(agent.startedAt))} · ${plural(agent.toolUses, "tool")}${
      live && agent.latestTool ? ` · ${agent.latestTool}` : ""
    }`,
    ...(!isRunning(card) && card.detail ? { summary: card.detail } : {}),
  };
}

/** The message Agent tasks shows in place of cards, or null when there are cards to show. */
export function agentsNotice(
  source: MissionSource | null,
): { lines: string[]; status?: true } | null {
  if (!source)
    return { lines: ["Open a chat tab to track the sub-agents it spawns."] };
  const label = HARNESS_LABELS[source.harness];
  if (source.agents === "unsupported_host")
    return { lines: ["This host's app doesn't share sub-agents yet."] };
  if (source.agents === "no_reporting")
    return {
      lines: [
        `${label} doesn't report sub-agents, so this tab has none to track.`,
      ],
    };
  if (source.agents === "loading")
    return { lines: [source.error ?? "Loading sub-agents…"], status: true };
  if (source.cards.length) return null;
  if (!source.spectator)
    return {
      lines: [
        "No sub-agents in this tab yet.",
        `When ${label} spawns sub-agents, they appear here grouped by turn. Select one to read its transcript.`,
      ],
    };
  return {
    lines: source.spectator.ended
      ? ["The host shared no sub-agents from this tab."]
      : [
          "No sub-agents in this tab yet.",
          `When the host's ${label} spawns sub-agents, they appear here grouped by turn.`,
        ],
  };
}

/** Notes above a spectator's cards: ended history and a capped load. */
export function agentsNotes(source: MissionSource | null) {
  if (!source?.spectator || !source.cards.length) return [];
  return [
    ...(source.spectator.ended
      ? ["The host turned read-along off. These sub-agents stay as history."]
      : []),
    ...(source.spectator.capped
      ? ["Showing the latest sub-agents; earlier ones are not loaded."]
      : []),
  ];
}

/** What Lead context says when the tab has no plan to show. */
export function planNotice(source: MissionSource) {
  return source.agents === "unsupported_host"
    ? "This host's app doesn't share its plan yet."
    : `No plan in this tab. ${HARNESS_LABELS[source.harness]} shows its plan here when it keeps one.`;
}
