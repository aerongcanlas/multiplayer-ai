import type { AgentCard, TranscriptEntry } from "../../shared/tabs";
import type { HarnessEvent } from "../harnesses/contract";
import { oneLine, type TranscriptWriter } from "./transcript";

type AgentEvent = Extract<HarnessEvent, { type: "agent" }>;
type Settled = Exclude<AgentCard["status"], "running">;
interface Card {
  entryId: string;
  // The turn the sub-agent's entries file under.
  turnId: string | null;
}

const NOTES = {
  stopped: "Stopped before finishing",
  interrupted: "Interrupted before finishing",
} as const;
const now = () => new Date().toISOString();

/** Sub-agent cards by tab: one transcript entry per sub-agent, editable while it runs. */
export class AgentCards {
  private tabs = new Map<string, Map<string, Card>>();

  constructor(
    private store: { agentCards(tabId: string): TranscriptEntry[] },
    private writer: TranscriptWriter,
  ) {}

  private of(tabId: string) {
    let cards = this.tabs.get(tabId);
    if (!cards) {
      cards = new Map();
      this.tabs.set(tabId, cards);
    }
    return cards;
  }

  private agentOf(card: Card | undefined) {
    return card && this.writer.entry(card.entryId)?.agent;
  }

  /** The turn a known sub-agent's entries file under; undefined for an unknown key. */
  turnOf(tabId: string, key: string) {
    return this.tabs.get(tabId)?.get(key)?.turnId;
  }

  running(tabId: string) {
    const cards = this.tabs.get(tabId);
    if (!cards) return 0;
    return [...cards.values()].filter(
      (card) => this.agentOf(card)?.status === "running",
    ).length;
  }

  /** Counts a tool use on a running card. */
  toolUsed(tabId: string, key: string, summary: string) {
    const card = this.tabs.get(tabId)?.get(key);
    const agent = this.agentOf(card);
    if (card && agent?.status === "running")
      this.writer.update(card.entryId, {
        agent: {
          ...agent,
          toolUses: agent.toolUses + 1,
          latestTool: oneLine(summary, 200),
        },
      });
  }

  /** Creates or updates a card from a harness event. Returns the card's status afterwards. */
  apply(
    roomId: string,
    tabId: string,
    turnId: string | undefined,
    event: AgentEvent,
  ): AgentCard["status"] {
    const cards = this.of(tabId);
    const known = cards.get(event.key);
    const entry = known && this.cardEntry(roomId, tabId, known.entryId);
    const fields: Partial<AgentCard> = {
      ...(event.agentType !== undefined ? { type: event.agentType } : {}),
      ...(event.name !== undefined ? { name: event.name } : {}),
      ...(event.model !== undefined ? { model: event.model } : {}),
      ...(event.background !== undefined
        ? { background: event.background }
        : {}),
      ...(event.toolUses !== undefined ? { toolUses: event.toolUses } : {}),
      ...(event.latestTool !== undefined
        ? { latestTool: oneLine(event.latestTool, 200) }
        : {}),
    };
    if (!known || !entry?.agent) {
      const parent = event.parentKey ? cards.get(event.parentKey) : undefined;
      const filed = turnId ?? parent?.turnId ?? null;
      const created = this.writer.append(roomId, tabId, {
        turnId: filed,
        kind: "agent",
        summary: oneLine(event.description ?? "Sub-agent", 2_000),
        agent: {
          key: event.key,
          ...(event.parentKey ? { parentKey: event.parentKey } : {}),
          status: "running",
          background: false,
          startedAt: now(),
          toolUses: 0,
          ...fields,
        },
      });
      cards.set(event.key, { entryId: created.id, turnId: filed });
      if (event.status && event.status !== "running")
        this.end(created.id, created.agent!, event.status, event.summary);
    } else {
      const agent = { ...entry.agent, ...fields };
      const status = event.status ?? agent.status;
      const patch = {
        ...(event.description
          ? { summary: oneLine(event.description, 2_000) }
          : {}),
      };
      if (status === "running" && agent.status !== "running") {
        // Re-engaged: new entries file under the turn that re-engaged it.
        known.turnId = turnId ?? known.turnId;
        delete agent.endedAt;
        this.writer.update(entry.id, {
          ...patch,
          agent: { ...agent, status },
        });
      } else if (status !== "running" && agent.status === "running") {
        this.writer.update(entry.id, { ...patch, agent });
        this.end(entry.id, agent, status, event.summary);
      } else
        this.writer.update(entry.id, {
          ...patch,
          ...(event.summary !== undefined ? { detail: event.summary } : {}),
          agent: { ...agent, status },
        });
    }
    return this.agentOf(cards.get(event.key))?.status ?? "running";
  }

  /** A card entry, reloaded from the journal when the writer already released it. */
  private cardEntry(roomId: string, tabId: string, entryId: string) {
    const entry = this.writer.entry(entryId);
    if (entry) return entry;
    const stored = this.store
      .agentCards(tabId)
      .find((item) => item.id === entryId);
    if (!stored) return undefined;
    this.writer.adopt(roomId, stored);
    return this.writer.entry(entryId);
  }

  /** Settles a running card; stopped and interrupted cards get a note in place of a summary. */
  private end(
    entryId: string,
    agent: AgentCard,
    status: Settled,
    summary?: string,
  ) {
    const detail =
      summary ??
      (status === "stopped" || status === "interrupted"
        ? NOTES[status]
        : undefined);
    this.writer.update(entryId, {
      agent: { ...agent, status, endedAt: now() },
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  /** Settles every running card of a tab, once its session can no longer finish them. */
  settle(tabId: string, outcome: "stopped" | "interrupted") {
    const cards = this.tabs.get(tabId);
    if (!cards) return;
    for (const card of cards.values()) {
      const agent = this.agentOf(card);
      if (agent?.status === "running") this.end(card.entryId, agent, outcome);
    }
    cards.clear();
  }

  /** After a restart, marks the cards the journal still shows running as interrupted. */
  recover(roomId: string, tabId: string) {
    const running = this.store
      .agentCards(tabId)
      .filter((entry) => entry.agent?.status === "running");
    for (const entry of running) {
      this.writer.adopt(roomId, entry);
      this.end(entry.id, entry.agent!, "interrupted");
    }
    return running.length;
  }

  forget(tabId: string) {
    this.tabs.delete(tabId);
  }
}
