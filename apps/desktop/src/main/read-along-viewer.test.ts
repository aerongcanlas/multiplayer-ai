import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  signedOutState,
  type SharedTab,
  type SharedTranscriptMessage,
} from "../shared/collaboration";
import { ReadAlongViewer } from "./read-along-viewer";
import type { ReadAlongOutcome } from "./collaboration-client";

const idle = async () => {
  for (let index = 0; index < 20; index++)
    await new Promise((resolve) => setImmediate(resolve));
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await wait(5);
  assert.ok(check());
};

function setup() {
  const roomId = randomUUID();
  const record: SharedTab = {
    tabId: randomUUID(),
    roomId,
    hostId: randomUUID(),
    hostName: "Alice",
    deviceId: "alice-desktop",
    title: "Fix the build",
    harness: "codex",
    model: "gpt-5",
    status: "running",
    switchOn: true,
    rev: 1,
    updatedAt: "2026-09-26T00:00:00Z",
  };
  let listed: SharedTab[] = [record];
  let visible = true;
  const calls: Record<string, unknown>[] = [];
  const replies: (
    ReadAlongOutcome<unknown> | Promise<ReadAlongOutcome<unknown>>
  )[] = [];
  // The one-time cards load is answered apart from the transcript pulls.
  const cardCalls: Record<string, unknown>[] = [];
  const cardReplies: ReadAlongOutcome<unknown>[] = [];
  const messages: SharedTranscriptMessage[] = [];
  const entry = (
    seq: number,
    rev: number,
    extra: Record<string, unknown> = {},
  ) => ({
    seq,
    kind: "assistant",
    share: "full",
    summary: `Line ${seq}`,
    text: `Line ${seq}`,
    version: 1,
    rev,
    updatedAt: "2026-09-26T00:00:00Z",
    ...extra,
  });
  const page = (
    entries: unknown[],
    patch: Record<string, unknown> = {},
    next: unknown = null,
  ) => ({
    ok: true as const,
    data: {
      record: { ...record, ...patch },
      entries,
      next,
      now: "2026-09-26T00:00:05Z",
    },
  });
  const collaboration = {
    state: {
      ...signedOutState(),
      auth: "signed_in" as const,
      status: "connected" as "connected" | "offline",
    },
    currentEpoch: 1,
    async readAlong<T>(_name: string, args: Record<string, unknown>) {
      if (String(args.p_kinds) === "agent") {
        cardCalls.push(args);
        return (cardReplies.shift() ?? page([])) as ReadAlongOutcome<T>;
      }
      calls.push(args);
      return ((await replies.shift()) ?? page([])) as ReadAlongOutcome<T>;
    },
  };
  const viewer = new ReadAlongViewer(
    collaboration as never,
    (id) => (id === roomId ? listed : undefined),
    (message) => messages.push(message),
    () => visible,
    5,
  );
  return {
    roomId,
    record,
    calls,
    replies,
    cardCalls,
    cardReplies,
    messages,
    card: (seq: number, rev: number, version = 1, status = "running") =>
      entry(seq, rev, {
        kind: "agent",
        summary: `Task ${seq}`,
        text: undefined,
        version,
        agent: {
          key: `agent-${seq}`,
          status,
          background: false,
          startedAt: "2026-09-26T00:00:00Z",
          toolUses: 0,
        },
      }),
    cards: () =>
      messages.flatMap((message) =>
        message.type === "cards"
          ? message.cards.map((item) => [item.seq, item.version])
          : [],
      ),
    cardStates: () =>
      messages.flatMap((message) =>
        message.type === "cards" && message.state ? [message.state] : [],
      ),
    entry,
    page,
    collaboration,
    viewer,
    setListed: (value: SharedTab[]) => (listed = value),
    setVisible: (value: boolean) => (visible = value),
    entries: () =>
      messages.flatMap((message) =>
        message.type === "entries"
          ? message.entries.map((item) => item.seq)
          : [],
      ),
    states: () =>
      messages.flatMap((message) =>
        message.type === "status" ? [message.state] : [],
      ),
  };
}

test("an initial page loads newest first, then deltas poll every tick while running", async () => {
  const s = setup();
  s.replies.push(
    s.page([s.entry(5, 1), s.entry(4, 1)], { rev: 1 }, { rev: 1, seq: 4 }),
  );
  s.replies.push(
    s.page(
      [
        s.entry(3, 2, {
          kind: "approval",
          share: "summary",
          state: "cancelled",
          text: undefined,
        }),
      ],
      { rev: 2, title: "Renamed" },
    ),
  );
  await s.viewer.watch(s.roomId, s.record.tabId);
  const first = s.messages.find((message) => message.type === "entries")!;
  assert.equal(first.type === "entries" && first.earlierSeq, 4);
  assert.deepEqual(s.calls[0], {
    p_tab_id: s.record.tabId,
    p_before_seq: null,
    p_limit: 200,
    p_byte_budget: 1048576,
    p_after_rev: null,
    p_after_seq: null,
  });
  await until(() => s.calls.length >= 3);
  // The delta starts past everything the record's rev covered.
  assert.equal(s.calls[1].p_after_rev, 1);
  assert.equal(s.calls[1].p_after_seq, 2147483647);
  const delta = s.messages.filter((message) => message.type === "entries")[1];
  assert.ok(delta.type === "entries" && delta.record.title === "Renamed");
  assert.deepEqual(s.entries().slice(0, 3), [5, 4, 3]);
  // The cursor advanced to the last row received.
  assert.equal(s.calls[2].p_after_rev, 2);
  assert.equal(s.calls[2].p_after_seq, 3);
  s.viewer.close();
});

test("an idle record stops polling until a snapshot or pull reports running", async () => {
  const s = setup();
  s.replies.push(s.page([], { status: "idle" }));
  await s.viewer.watch(s.roomId, s.record.tabId);
  await wait(30);
  assert.equal(s.calls.length, 1);
  s.replies.push(s.page([], { status: "running" }));
  s.viewer.snapshotChanged();
  await until(() => s.calls.length > 3);
  s.viewer.close();
});

test("a page cut by the byte budget is followed at once without skipping its rev", async () => {
  const s = setup();
  s.replies.push(s.page([], { rev: 1, status: "idle" }));
  await s.viewer.watch(s.roomId, s.record.tabId);
  s.replies.push(
    s.page([s.entry(6, 2)], { rev: 2, status: "idle" }, { rev: 2, seq: 6 }),
  );
  s.replies.push(s.page([s.entry(7, 2)], { rev: 2, status: "idle" }));
  s.viewer.snapshotChanged();
  await idle();
  assert.equal(s.calls.length, 3);
  assert.deepEqual([s.calls[2].p_after_rev, s.calls[2].p_after_seq], [2, 6]);
  assert.deepEqual(s.entries(), [6, 7]);
  s.viewer.close();
});

test("a tick while a pull is in flight is skipped, and a hidden window pauses polling", async () => {
  const s = setup();
  s.replies.push(s.page([], { status: "idle" }));
  await s.viewer.watch(s.roomId, s.record.tabId);
  let release!: (value: ReadAlongOutcome<unknown>) => void;
  s.replies.push(new Promise((resolve) => (release = resolve)));
  s.viewer.snapshotChanged();
  await idle();
  assert.equal(s.calls.length, 2);
  s.viewer.snapshotChanged();
  s.viewer.visibilityChanged();
  await idle();
  assert.equal(s.calls.length, 2);
  s.setVisible(false);
  release(s.page([], { status: "running" }));
  await wait(30);
  assert.equal(s.calls.length, 2);
  s.setVisible(true);
  // An idle reply keeps the 5 ms poll from adding a fourth pull on a slow machine.
  s.replies.push(s.page([], { status: "idle" }));
  s.viewer.visibilityChanged();
  await idle();
  assert.equal(s.calls.length, 3);
  s.viewer.close();
});

test("a row failing the strict schema drops the batch without touching collaboration status", async () => {
  const s = setup();
  s.replies.push(s.page([s.entry(3, 1, { detail: "x", agentKey: "leak" })]));
  await s.viewer.watch(s.roomId, s.record.tabId);
  assert.deepEqual(s.entries(), []);
  assert.equal(s.collaboration.state.status, "connected");
  s.viewer.close();
});

test("sign-out mid-watch drops the in-flight result and clears shared entries", async () => {
  const s = setup();
  let release!: (value: ReadAlongOutcome<unknown>) => void;
  s.replies.push(new Promise((resolve) => (release = resolve)));
  const watching = s.viewer.watch(s.roomId, s.record.tabId);
  await idle();
  s.collaboration.currentEpoch = 2;
  s.viewer.snapshotChanged();
  release(s.page([s.entry(3, 1)]));
  await watching;
  assert.deepEqual(s.entries(), []);
  assert.deepEqual(s.messages.at(-1), { type: "clear" });
  s.viewer.close();
});

test("watching an unlisted tab is refused; a tab leaving the list or a 42501 reads unshared", async () => {
  const s = setup();
  await assert.rejects(
    s.viewer.watch(s.roomId, randomUUID()),
    /no longer available/,
  );
  s.replies.push(s.page([], { status: "idle" }));
  await s.viewer.watch(s.roomId, s.record.tabId);
  s.setListed([]);
  s.viewer.snapshotChanged();
  assert.equal(s.states().at(-1), "unshared");
  s.setListed([s.record]);
  s.replies.push({ ok: false, reason: "not_member" });
  await s.viewer.watch(s.roomId, s.record.tabId);
  assert.equal(s.states().at(-1), "unshared");
  s.viewer.close();
});

test("a missing migration reads load failed, and a later delta failure reads reconnecting", async () => {
  const s = setup();
  s.replies.push({ ok: false, reason: "migration_missing" });
  await s.viewer.watch(s.roomId, s.record.tabId);
  assert.equal(s.states().at(-1), "failed");
  assert.equal(s.collaboration.state.status, "connected");
  s.viewer.unwatch();
  s.replies.push(s.page([], { status: "idle" }));
  await s.viewer.watch(s.roomId, s.record.tabId);
  s.replies.push({ ok: false, reason: "retry" });
  s.viewer.snapshotChanged();
  await idle();
  assert.equal(s.states().at(-1), "reconnecting");
  s.collaboration.state.status = "offline";
  s.viewer.snapshotChanged();
  assert.equal(s.states().at(-1), "reconnecting");
  s.viewer.close();
});

test("loading earlier entries pages below the requested seq", async () => {
  const s = setup();
  s.replies.push(s.page([], { status: "idle" }));
  await s.viewer.watch(s.roomId, s.record.tabId);
  s.replies.push(s.page([s.entry(2, 1), s.entry(1, 1)], { status: "idle" }));
  await s.viewer.loadEarlier(s.roomId, s.record.tabId, 3);
  assert.equal(s.calls.at(-1)!.p_before_seq, 3);
  const earlier = s.messages
    .filter((message) => message.type === "entries")
    .at(-1)!;
  assert.ok(earlier.type === "entries" && earlier.earlierSeq === null);
  await assert.rejects(
    s.viewer.loadEarlier(s.roomId, randomUUID(), 3),
    /Open the shared tab/,
  );
  s.viewer.close();
});

const LEAD = [
  "user",
  "assistant",
  "plan",
  "tool",
  "approval",
  "notice",
  "error",
  "turn",
];

test("watching loads every card apart from a transcript page of lead entries only", async () => {
  const s = setup();
  s.cardReplies.push(
    s.page([s.card(40, 3), s.card(30, 2), s.card(20, 2, 2, "completed")], {
      rev: 3,
    }),
  );
  // 500 lead entries: the first page holds the newest 200 and no card.
  const lead = Array.from({ length: 200 }, (_, index) =>
    s.entry(600 - index, 3),
  );
  s.replies.push(
    s.page(lead, { rev: 4, status: "idle" }, { rev: 3, seq: 401 }),
  );
  await s.viewer.watch(s.roomId, s.record.tabId);
  assert.deepEqual(s.cards(), [
    [40, 1],
    [30, 1],
    [20, 2],
  ]);
  assert.deepEqual(s.cardStates(), ["ready"]);
  assert.equal(s.entries().length, 200);
  assert.deepEqual(s.cardCalls[0], {
    p_tab_id: s.record.tabId,
    p_before_seq: null,
    p_limit: 200,
    p_byte_budget: 1048576,
    p_after_rev: null,
    p_after_seq: null,
    p_kinds: ["agent"],
  });
  // The transcript asks for lead kinds only, and so does "Load earlier".
  assert.deepEqual(s.calls[0].p_kinds, LEAD);
  s.replies.push(s.page([s.entry(400, 3)], { status: "idle" }));
  await s.viewer.loadEarlier(s.roomId, s.record.tabId, 401);
  assert.deepEqual(s.calls.at(-1)!.p_kinds, LEAD);
  assert.equal(s.calls.at(-1)!.p_before_seq, 401);
  // The cards load ran once.
  assert.equal(s.cardCalls.length, 1);
  s.viewer.close();
});

test("a tail pull delivers a card update and a transcript entry to their own consumers", async () => {
  const s = setup();
  s.cardReplies.push(s.page([s.card(3, 2)], { rev: 2 }));
  s.replies.push(s.page([s.entry(4, 5)], { rev: 5, status: "idle" }));
  await s.viewer.watch(s.roomId, s.record.tabId);
  // Covers AE2: the tail starts at the rev the cards were read at and carries every kind.
  s.replies.push(
    s.page([s.card(3, 6, 2, "completed"), s.entry(5, 6), s.card(3, 6, 2)], {
      rev: 6,
      status: "idle",
      runningAgents: 0,
      reportsAgents: true,
    }),
  );
  s.viewer.snapshotChanged();
  await idle();
  assert.deepEqual(
    [s.calls[1].p_after_rev, s.calls[1].p_after_seq, s.calls[1].p_kinds],
    [2, 2147483647, undefined],
  );
  assert.deepEqual(s.entries(), [4, 5]);
  assert.deepEqual(s.cards(), [
    [3, 1],
    [3, 2],
  ]);
  const tail = s.messages.filter((message) => message.type === "entries")[1];
  assert.ok(tail.type === "entries" && tail.record.reportsAgents === true);
  const update = s.messages.filter((message) => message.type === "cards")[1];
  assert.ok(
    update.type === "cards" &&
      update.state === undefined &&
      update.cards[0].agent?.status === "completed",
  );
  s.viewer.close();
});

test("a database without the kinds filter still shows the transcript, with cards unavailable", async () => {
  const s = setup();
  s.cardReplies.push({ ok: false, reason: "migration_missing" });
  s.replies.push(s.page([s.entry(2, 1)], { status: "idle" }));
  await s.viewer.watch(s.roomId, s.record.tabId);
  assert.deepEqual(s.cardStates(), ["unavailable"]);
  assert.deepEqual(s.entries(), [2]);
  assert.deepEqual(s.states(), ["loading", "live"]);
  // No later pull sends the argument, and the cards load is not tried again.
  s.replies.push(s.page([], { status: "idle" }));
  s.viewer.snapshotChanged();
  await idle();
  s.replies.push(s.page([], { status: "idle" }));
  await s.viewer.loadEarlier(s.roomId, s.record.tabId, 2);
  assert.ok(s.calls.every((call) => !("p_kinds" in call)));
  assert.equal(s.cardCalls.length, 1);
  s.viewer.close();
});

test("more than 200 cards page through, and past 1,000 the load says it is capped", async () => {
  const s = setup();
  const cardPage = (from: number, next: boolean) =>
    s.page(
      Array.from({ length: 200 }, (_, index) => s.card(from - index, 1)),
      {},
      next ? { rev: 1, seq: from - 199 } : null,
    );
  s.cardReplies.push(cardPage(450, true), cardPage(250, false));
  s.replies.push(s.page([], { status: "idle" }));
  await s.viewer.watch(s.roomId, s.record.tabId);
  assert.equal(s.cards().length, 400);
  assert.deepEqual(s.cardStates(), ["ready"]);
  assert.deepEqual(
    s.cardCalls.map((call) => call.p_before_seq),
    [null, 251],
  );
  s.viewer.unwatch();
  s.cardReplies.push(
    ...[5000, 4800, 4600, 4400, 4200].map((from) => cardPage(from, true)),
  );
  s.replies.push(s.page([], { status: "idle" }));
  await s.viewer.watch(s.roomId, s.record.tabId);
  assert.equal(s.cards().length, 1400);
  assert.deepEqual(s.cardStates(), ["ready", "capped"]);
  assert.equal(s.cardCalls.length, 7);
  s.viewer.close();
});

test("a reconnect resumes the tail from its cursor and re-delivers no stale card version", async () => {
  const s = setup();
  s.cardReplies.push(s.page([s.card(3, 4, 4)], { rev: 4 }));
  s.replies.push(s.page([], { rev: 4, status: "idle" }));
  await s.viewer.watch(s.roomId, s.record.tabId);
  s.replies.push(s.page([s.card(3, 5, 5)], { rev: 5, status: "idle" }));
  s.viewer.snapshotChanged();
  await idle();
  s.replies.push({ ok: false, reason: "retry" });
  s.viewer.snapshotChanged();
  await idle();
  assert.equal(s.states().at(-1), "reconnecting");
  // The server answers again with rows the viewer already holds, one of them older.
  s.replies.push(
    s.page([s.card(3, 5, 5), s.card(3, 5, 4)], { rev: 5, status: "idle" }),
  );
  s.viewer.snapshotChanged();
  await idle();
  assert.deepEqual(
    [s.calls.at(-1)!.p_after_rev, s.calls.at(-1)!.p_after_seq],
    [5, 3],
  );
  assert.deepEqual(s.cards(), [
    [3, 4],
    [3, 5],
  ]);
  assert.equal(s.cardCalls.length, 1);
  assert.equal(s.states().at(-1), "live");
  s.viewer.close();
});

test("a cards load that fails is tried again on the next pull", async () => {
  const s = setup();
  s.cardReplies.push({ ok: false, reason: "retry" });
  s.replies.push(s.page([s.entry(2, 1)], { status: "idle" }));
  await s.viewer.watch(s.roomId, s.record.tabId);
  assert.deepEqual(s.cardStates(), []);
  assert.deepEqual(s.entries(), [2]);
  s.cardReplies.push(s.page([s.card(3, 2)], { rev: 2 }));
  s.replies.push(s.page([], { rev: 2, status: "idle" }));
  s.viewer.snapshotChanged();
  await idle();
  assert.deepEqual(s.cardStates(), ["ready"]);
  assert.deepEqual(s.cards(), [[3, 1]]);
  s.viewer.close();
});
