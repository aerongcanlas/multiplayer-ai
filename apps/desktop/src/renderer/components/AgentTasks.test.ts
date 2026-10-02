import test from "node:test";
import assert from "node:assert/strict";
import type { SharedTab } from "../../shared/collaboration";
import type { HarnessState, Tab } from "../../shared/tabs";
import {
  agentCount,
  agentsNotes,
  agentsNotice,
  cardView,
  groupByTurn,
  missionSource,
  missionSubtitle,
  planNotice,
} from "../lib/mission";
import type { SharedAgentEntry } from "../lib/read-along";
import type { SharedAgents } from "../lib/transcript-store";

const START = "2026-10-02T00:00:00.000Z";
const now = Date.parse(START) + 65_000;
const card = (
  seq: number,
  agent: Partial<SharedAgentEntry["agent"]> = {},
  patch: Partial<SharedAgentEntry> = {},
): SharedAgentEntry => ({
  id: `card-${seq}`,
  tabId: "tab",
  seq,
  turnId: "turn-1",
  kind: "agent",
  share: "full",
  summary: `Task ${seq}`,
  agent: {
    key: `agent-${seq}`,
    status: "running",
    background: false,
    startedAt: START,
    toolUses: 2,
    latestTool: "Read notes.txt",
    ...agent,
  },
  createdAt: START,
  updatedAt: "2026-10-02T00:00:30.000Z",
  ...patch,
});
const tab = (patch: Partial<Tab> = {}): Tab => ({
  id: crypto.randomUUID(),
  roomId: crypto.randomUUID(),
  title: "My tab",
  loadout: { harness: "claude", model: "opus", planMode: true, access: "ask" },
  status: "awaiting_host",
  readAlong: false,
  readAlongWindows: [],
  runningAgents: 1,
  plan: {
    turnId: null,
    steps: [{ text: "Mine", status: "active" }],
    updatedAt: START,
  },
  createdAt: START,
  updatedAt: START,
  ...patch,
});
const harness = (reportsAgents = true) =>
  ({
    id: "claude",
    models: [{ id: "opus", name: "Opus" }],
    reportsAgents,
  }) as HarnessState;
const record = (patch: Partial<SharedTab> = {}): SharedTab => ({
  tabId: crypto.randomUUID(),
  roomId: crypto.randomUUID(),
  hostId: crypto.randomUUID(),
  hostName: "Alice",
  deviceId: "alice-desktop",
  title: "Host tab",
  harness: "codex",
  model: "gpt-5",
  status: "running",
  switchOn: true,
  rev: 1,
  updatedAt: START,
  reportsAgents: true,
  ...patch,
});
const shared = (patch: Partial<SharedAgents> = {}): SharedAgents => ({
  record: null,
  cards: [],
  plan: null,
  runningAgents: 0,
  availability: "ready",
  capped: false,
  ...patch,
});
const own = { cards: [card(1)], loaded: true, error: null };
const watch = (
  patch: Partial<SharedTab> = {},
  agents: Partial<SharedAgents> = {},
) =>
  missionSource({
    tab: tab(),
    harness: harness(),
    own,
    watched: { record: record(patch), agents: shared(agents) },
  });

test("Mission Control follows the tab in the main area and never mixes the two", () => {
  const mine = tab();
  const base = { tab: mine, harness: harness(), own };
  // Covers AE1: an own tab shows the member's lead and cards.
  const before = missionSource({ ...base, watched: null })!;
  assert.equal(before.spectator, undefined);
  assert.equal(before.title, "My tab");
  assert.deepEqual(
    before.facts.map((fact) => fact.value),
    ["Claude Code", "Opus", "Plan", "Waiting for you"],
  );
  assert.equal(before.plan.steps[0].text, "Mine");
  assert.deepEqual(before.cards, own.cards);
  assert.equal(missionSubtitle(before), "My tab · 1 sub-agent running");
  // Opening a host's shared tab switches every column to the host's data.
  const hostCards = [card(7, { status: "completed" }), card(8)];
  const watching = missionSource({
    ...base,
    watched: {
      record: record(),
      agents: shared({
        cards: hostCards,
        runningAgents: 1,
        plan: {
          explanation: "Why",
          steps: [{ text: "Theirs", status: "done" }],
        },
      }),
    },
  })!;
  assert.equal(watching.spectator?.hostName, "Alice");
  assert.deepEqual(
    watching.facts.map((fact) => [fact.label, fact.value]),
    [
      ["Host", "Alice"],
      ["Harness", "Codex"],
      ["Model", "gpt-5"],
      ["Status", "Live"],
    ],
  );
  assert.deepEqual(watching.plan, {
    explanation: "Why",
    steps: [{ text: "Theirs", status: "done" }],
  });
  assert.deepEqual(watching.cards, hostCards);
  assert.equal(
    missionSubtitle(watching),
    "Alice · Host tab · 1 sub-agent running",
  );
  assert.equal(agentCount(watching), "1 running · 2");
  // Returning to the own tab shows the member's data again, with no host card left.
  const after = missionSource({ ...base, watched: null })!;
  assert.deepEqual(after, before);
  assert.ok(after.cards.every((item) => !hostCards.includes(item)));
  // No tab at all, and a shared tab whose record is gone, show nothing of either.
  assert.equal(
    missionSource({ tab: undefined, harness: undefined, own, watched: null }),
    null,
  );
  assert.equal(
    missionSource({
      ...base,
      watched: { record: undefined, agents: shared() },
    }),
    null,
  );
  assert.equal(missionSubtitle(null), "Follows the active chat tab");
  assert.equal(agentCount(null), null);
});

test("a spectator's card is not a control, and the owner's still is", () => {
  const spectator = watch()!;
  // Covers AE3: nothing to press, nothing selected.
  const view = cardView(card(1), spectator, now);
  assert.equal(view.interactive, false);
  assert.deepEqual(
    [view.statusLabel, view.meta],
    ["Running", "1m 05s · 2 tools · Read notes.txt"],
  );
  assert.equal(view.summary, undefined);
  const mine = missionSource({
    tab: tab(),
    harness: harness(),
    own,
    watched: null,
  })!;
  assert.equal(cardView(card(1), mine, now).interactive, true);
  const done = cardView(
    card(
      2,
      { status: "completed", endedAt: "2026-10-02T00:00:10.000Z", name: "a" },
      { detail: "Found it" },
    ),
    spectator,
    now,
  );
  assert.deepEqual(
    [done.statusLabel, done.meta, done.summary, done.kind],
    ["Completed", "10s · 2 tools", "Found it", "a"],
  );
});

test("a mid-run join shows running with its label, under the turn that spawned it", () => {
  const spectator = watch()!;
  // Covers AE5.
  const joined = cardView(card(1, {}, { joinedMidRun: true }), spectator, now);
  assert.deepEqual(
    [joined.status, joined.statusLabel, joined.joinedMidRun],
    ["running", "Running", true],
  );
  assert.equal(cardView(card(2), spectator, now).joinedMidRun, false);
  const groups = groupByTurn([
    card(1, {}, { turnId: "turn-1", joinedMidRun: true }),
    card(2, { parentKey: "agent-1" }, { turnId: "turn-1" }),
    card(5, {}, { turnId: "turn-2" }),
    card(6, { parentKey: "gone" }, { turnId: "turn-2" }),
    card(9, {}, { turnId: null }),
  ]);
  assert.deepEqual(
    groups.map((group) => [
      group.turnId,
      group.ordered.map(({ card, depth }) => [card.seq, depth]),
    ]),
    [
      ["", [[9, 0]]],
      [
        "turn-2",
        [
          [5, 0],
          [6, 0],
        ],
      ],
      [
        "turn-1",
        [
          [1, 0],
          [2, 1],
        ],
      ],
    ],
  );
});

test("a host tab waiting on its owner is marked for the spectator, with nothing to act on", () => {
  // Covers AE7.
  const waiting = watch(
    { status: "awaiting_host" },
    { cards: [card(1)], runningAgents: 1 },
  )!;
  assert.equal(waiting.spectator?.needsHost, true);
  assert.equal(waiting.status, "Waiting on the host");
  assert.equal(
    missionSubtitle(waiting),
    "Alice · Host tab · 1 sub-agent running · needs the host",
  );
  assert.equal(cardView(card(1), waiting, now).interactive, false);
  assert.equal(watch()!.spectator?.needsHost, false);
});

test("each empty state has its own message", () => {
  const lines = (source: ReturnType<typeof watch>) =>
    agentsNotice(source)?.lines;
  assert.deepEqual(lines(null), [
    "Open a chat tab to track the sub-agents it spawns.",
  ]);
  const older = watch({}, { availability: "unsupported_host" })!;
  assert.deepEqual(lines(older), [
    "This host's app doesn't share sub-agents yet.",
  ]);
  assert.equal(
    planNotice(older),
    "This host's app doesn't share its plan yet.",
  );
  assert.deepEqual(lines(watch({}, { availability: "no_reporting" })), [
    "Codex doesn't report sub-agents, so this tab has none to track.",
  ]);
  // The same wording the owner of a non-reporting harness reads.
  assert.deepEqual(
    lines(
      missionSource({
        tab: tab({
          loadout: {
            harness: "codex",
            model: "",
            planMode: false,
            access: "ask",
          },
        }),
        harness: { ...harness(false), id: "codex" },
        own,
        watched: null,
      }),
    ),
    ["Codex doesn't report sub-agents, so this tab has none to track."],
  );
  const loading = agentsNotice(watch({}, { availability: "loading" }));
  assert.deepEqual(loading, { lines: ["Loading sub-agents…"], status: true });
  assert.deepEqual(
    agentsNotice(
      missionSource({
        tab: tab(),
        harness: harness(),
        own: {
          cards: [],
          loaded: false,
          error: "Sub-agents could not be loaded.",
        },
        watched: null,
      }),
    )?.lines,
    ["Sub-agents could not be loaded."],
  );
  assert.deepEqual(lines(watch()), [
    "No sub-agents in this tab yet.",
    "When the host's Codex spawns sub-agents, they appear here grouped by turn.",
  ]);
  assert.match(
    lines(
      missionSource({
        tab: tab(),
        harness: harness(),
        own: { cards: [], loaded: true, error: null },
        watched: null,
      }),
    )![1],
    /Select one to read its transcript/,
  );
  assert.equal(
    planNotice(watch()!),
    "No plan in this tab. Codex shows its plan here when it keeps one.",
  );
  // Covers AE6: an ended share keeps its cards as history, and a running one stops counting.
  const ended = watch(
    { status: "ended", switchOn: false },
    { cards: [card(1), card(2, { status: "completed" })], runningAgents: 1 },
  )!;
  assert.equal(agentsNotice(ended), null);
  assert.deepEqual(agentsNotes(ended), [
    "The host turned read-along off. These sub-agents stay as history.",
  ]);
  assert.equal(ended.running, 0);
  assert.equal(agentCount(ended), "2");
  const frozen = cardView(card(1), ended, now);
  assert.deepEqual(
    [frozen.status, frozen.statusLabel, frozen.meta],
    ["stopped", "Was running", "30s · 2 tools"],
  );
  assert.deepEqual(lines(watch({ status: "ended" })), [
    "The host shared no sub-agents from this tab.",
  ]);
  assert.deepEqual(agentsNotes(watch({}, { cards: [card(1)], capped: true })), [
    "Showing the latest sub-agents; earlier ones are not loaded.",
  ]);
  assert.deepEqual(agentsNotes(watch({}, { cards: [card(1)] })), []);
});
