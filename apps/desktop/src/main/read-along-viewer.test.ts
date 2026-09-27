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
    messages,
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
