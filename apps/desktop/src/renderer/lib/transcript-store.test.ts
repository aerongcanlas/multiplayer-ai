import test from "node:test";
import assert from "node:assert/strict";
import type { SharedEntry, SharedTab } from "../../shared/collaboration";
import {
  acceptShared,
  sharedAgents,
  sharedTranscript,
} from "./transcript-store";
import {
  ageLabel,
  asTranscriptEntry,
  sharedGroups,
  switchCaption,
} from "./read-along";

const record = (patch: Partial<SharedTab> = {}): SharedTab => ({
  tabId: crypto.randomUUID(),
  roomId: crypto.randomUUID(),
  hostId: crypto.randomUUID(),
  hostName: "Alice",
  deviceId: "alice-desktop",
  title: "Tab",
  harness: "codex",
  model: "m",
  status: "running",
  switchOn: true,
  rev: 1,
  updatedAt: "2026-09-26T00:00:00.000Z",
  ...patch,
});
const entry = (seq: number, text: string, version = 1): SharedEntry => ({
  seq,
  kind: "assistant",
  share: "full",
  summary: text,
  text,
  version,
  rev: 1,
  updatedAt: "2026-09-26T00:00:00.000Z",
});

test("shared batches merge by seq, never regress to an older version, and clear on account change", () => {
  const tab = record();
  const base = { roomId: tab.roomId, tabId: tab.tabId, record: tab, now: "" };
  acceptShared({
    type: "entries",
    ...base,
    entries: [entry(2, "b"), entry(1, "a")],
    earlierSeq: 1,
  });
  acceptShared({ type: "entries", ...base, entries: [entry(2, "b grown", 3)] });
  // A delayed publish of older text arrives after the newer one.
  acceptShared({ type: "entries", ...base, entries: [entry(2, "b", 2)] });
  const held = sharedTranscript(tab.tabId);
  assert.deepEqual(
    held.entries.map((item) => item.text),
    ["a", "b grown"],
  );
  assert.equal(held.earlierSeq, 1);
  acceptShared({
    type: "status",
    roomId: tab.roomId,
    tabId: tab.tabId,
    state: "live",
  });
  assert.equal(sharedTranscript(tab.tabId).state, "live");
  acceptShared({ type: "clear" });
  assert.deepEqual(sharedTranscript(tab.tabId).entries, []);
});

test("ages come from server time and read reconnecting while offline", () => {
  const now = Date.parse("2026-09-26T00:00:30.000Z");
  assert.equal(
    ageLabel("2026-09-26T00:00:00.000Z", true, 0, now),
    "Updated 30s ago",
  );
  // The local clock runs 10 s behind the server.
  assert.equal(
    ageLabel("2026-09-26T00:00:00.000Z", true, 10_000, now),
    "Updated 40s ago",
  );
  assert.equal(
    ageLabel("2026-09-26T00:00:00.000Z", false, 0, now),
    "Reconnecting…",
  );
});

test("tabs group per host, with this account's other desktop labelled apart", () => {
  const alice = record();
  const alice2 = record({ hostId: alice.hostId });
  const mine = record({
    hostName: "Me",
    sameUser: true,
    deviceId: "second-desktop",
  });
  const groups = sharedGroups([alice, mine, alice2]);
  assert.deepEqual(
    groups.map((group) => [group.label, group.tabs.length]),
    [
      ["Alice", 2],
      ["You · another desktop", 1],
    ],
  );
});

test("shared entries map to transcript entries and the switch caption follows publisher status", () => {
  const mapped = asTranscriptEntry("t", {
    ...entry(4, "Full text"),
    summary: "Full",
  });
  assert.equal(mapped.summary, "Full text");
  assert.equal(mapped.seq, 4);
  assert.equal(switchCaption({ state: "publishing" }, true), "Publishing");
  assert.equal(
    switchCaption({ state: "paused", buffered: 3 }, true),
    "Paused · 3 waiting to publish",
  );
  assert.match(
    switchCaption({ state: "stopped", reason: "not_member" }, false),
    /no longer a member/,
  );
  assert.match(
    switchCaption({ state: "stopped", reason: "migration_missing" }, false),
    /migration/,
  );
  assert.equal(switchCaption(undefined, false), "Off · this tab is private");
});

const card = (
  seq: number,
  version = 1,
  agent: Partial<NonNullable<SharedEntry["agent"]>> = {},
  text?: string,
): SharedEntry => ({
  seq,
  kind: "agent",
  share: "full",
  summary: `Task ${seq}`,
  ...(text ? { text } : {}),
  agent: {
    key: `agent-${seq}`,
    status: "running",
    background: false,
    startedAt: "2026-09-26T00:00:00.000Z",
    toolUses: 0,
    ...agent,
  },
  version,
  rev: 1,
  updatedAt: "2026-09-26T00:00:01.000Z",
});

test("shared cards merge by version apart from the transcript and map to the host's card shape", () => {
  const turnId = crypto.randomUUID();
  const tab = record({
    reportsAgents: true,
    runningAgents: 2,
    plan: { steps: [{ text: "Read", status: "active" }] },
  });
  const base = { roomId: tab.roomId, tabId: tab.tabId };
  assert.equal(sharedAgents(tab.tabId).availability, "loading");
  assert.equal(sharedAgents(null).availability, "loading");
  // A card inside a transcript message never reaches the transcript entries.
  acceptShared({
    type: "entries",
    ...base,
    record: tab,
    entries: [entry(1, "a"), card(2)],
    now: "",
  });
  assert.deepEqual(
    sharedTranscript(tab.tabId).entries.map((item) => item.seq),
    [1],
  );
  assert.equal(sharedAgents(tab.tabId).availability, "loading");
  acceptShared({
    type: "cards",
    ...base,
    cards: [card(2, 1, { turnId, joinedMidRun: true }), card(3)],
    state: "ready",
  });
  acceptShared({
    type: "cards",
    ...base,
    cards: [
      card(
        2,
        3,
        { turnId, joinedMidRun: true, status: "completed", toolUses: 4 },
        "Found it",
      ),
    ],
  });
  // A delayed older version never regresses the card.
  acceptShared({ type: "cards", ...base, cards: [card(2, 2, { turnId })] });
  const agents = sharedAgents(tab.tabId);
  assert.equal(agents.availability, "ready");
  assert.equal(agents.capped, false);
  assert.equal(agents.runningAgents, 2);
  assert.deepEqual(agents.plan, tab.plan);
  assert.deepEqual(
    agents.cards.map((item) => [item.seq, item.agent.status]),
    [
      [2, "completed"],
      [3, "running"],
    ],
  );
  assert.deepEqual(agents.cards[0], {
    id: `shared:${tab.tabId}:2`,
    tabId: tab.tabId,
    seq: 2,
    turnId,
    kind: "agent",
    share: "full",
    summary: "Task 2",
    detail: "Found it",
    agent: {
      key: "agent-2",
      status: "completed",
      background: false,
      startedAt: "2026-09-26T00:00:00.000Z",
      toolUses: 4,
    },
    joinedMidRun: true,
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:01.000Z",
  });
  assert.equal(agents.cards[1].turnId, null);
  // The snapshot is stable until the store changes.
  assert.equal(sharedAgents(tab.tabId), agents);
  assert.equal(sharedTranscript(tab.tabId).entries.length, 1);

  // Covers AE6: an ended record keeps its cards, plan, and availability.
  acceptShared({
    type: "entries",
    ...base,
    record: { ...tab, status: "ended", switchOn: false },
    entries: [],
    now: "",
  });
  const ended = sharedAgents(tab.tabId);
  assert.equal(ended.availability, "ready");
  assert.equal(ended.cards.length, 2);
  assert.deepEqual(ended.plan, tab.plan);

  // An account change clears cards and plan.
  acceptShared({ type: "clear" });
  assert.deepEqual(sharedAgents(tab.tabId), {
    record: null,
    cards: [],
    plan: null,
    runningAgents: 0,
    availability: "loading",
    capped: false,
  });
});

test("availability tells an older host from a harness that reports no sub-agents", () => {
  const state = (
    patch: Partial<SharedTab>,
    cards: "ready" | "capped" | "unavailable" = "ready",
  ) => {
    const tab = record(patch);
    const base = { roomId: tab.roomId, tabId: tab.tabId };
    acceptShared({
      type: "entries",
      ...base,
      record: tab,
      entries: [],
      now: "",
    });
    acceptShared({ type: "cards", ...base, cards: [], state: cards });
    return sharedAgents(tab.tabId);
  };
  assert.equal(state({}).availability, "unsupported_host");
  assert.equal(state({ reportsAgents: null }).availability, "unsupported_host");
  assert.equal(state({ reportsAgents: false }).availability, "no_reporting");
  assert.equal(state({ reportsAgents: true }).availability, "ready");
  // A database without the migration cannot return cards, whatever the record says.
  assert.equal(
    state({ reportsAgents: true }, "unavailable").availability,
    "unsupported_host",
  );
  const capped = state({ reportsAgents: true }, "capped");
  assert.deepEqual([capped.availability, capped.capped], ["ready", true]);
});
