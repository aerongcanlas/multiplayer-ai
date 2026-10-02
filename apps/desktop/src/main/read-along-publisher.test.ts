import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { signedOutState } from "../shared/collaboration";
import type { Room, Snapshot, SupervisorRequest } from "../shared/contracts";
import type {
  AgentCard,
  HarnessState,
  Tab,
  TranscriptEntry,
} from "../shared/tabs";
import {
  ReadAlongPublisher,
  projectPlan,
  recordStatus,
  type PublishedEntry,
  type PublishedRecord,
} from "./read-along-publisher";
import type { ReadAlongOutcome } from "./collaboration-client";

const userId = randomUUID();
const hostId = randomUUID();
const turnId = randomUUID();
const idle = async () => {
  for (let index = 0; index < 20; index++)
    await new Promise((resolve) => setImmediate(resolve));
};
let clock = 0;
const stamp = () =>
  new Date(Date.UTC(2026, 8, 26, 0, 0, 0, ++clock)).toISOString();

function setup(
  options: { windows?: Tab["readAlongWindows"]; connected?: boolean } = {},
) {
  const roomId = randomUUID();
  const tab: Tab = {
    id: randomUUID(),
    roomId,
    title: "Fix OPENAI_API_KEY=q8Zr2mVx4TnL7pWc",
    loadout: {
      harness: "codex",
      model: "gpt-5",
      planMode: false,
      access: "ask",
    },
    status: "running",
    readAlong: true,
    readAlongWindows: options.windows ?? [{ onSeq: 3, offSeq: null }],
    createdAt: stamp(),
    updatedAt: stamp(),
  };
  const room: Room = {
    id: roomId,
    name: "Shared",
    createdAt: stamp(),
    shared: { userId, project: "p", isAdmin: true, members: [] },
    workspace: null,
    messages: [],
    suggestions: [],
    tabs: [tab],
  };
  let revision = 0;
  // Set by a test to report harness state in the next snapshots.
  const extras: { harnesses?: HarnessState[] } = {};
  const journal = new Map<number, TranscriptEntry>();
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const replies: Record<string, ReadAlongOutcome<unknown>[]> = {};
  const requests: SupervisorRequest["command"][] = [];
  const state = {
    ...signedOutState(),
    auth: "signed_in" as const,
    account: { id: userId, name: "Alice" },
    status: (options.connected === false ? "offline" : "connected") as
      "connected" | "offline",
  };
  const collaboration = {
    state,
    rooms: [room] as Room[],
    currentEpoch: 1,
    refreshes: 0,
    async refresh() {
      collaboration.refreshes++;
    },
    async readAlong<T>(name: string, args: Record<string, unknown>) {
      calls.push({ name, args: structuredClone(args) });
      const reply = replies[name]?.shift();
      if (reply) return reply as ReadAlongOutcome<T>;
      return {
        ok: true,
        data:
          name === "desktop_tab_share_head"
            ? null
            : { maxSeq: 0, version: 0, rev: 1 },
      } as ReadAlongOutcome<T>;
    },
  };
  const snapshot = (): Snapshot => ({
    protocolVersion: 2,
    revision: ++revision,
    hostId,
    sync: "local-only",
    rooms: [structuredClone(room)],
    ...(extras.harnesses ? { harnesses: extras.harnesses } : {}),
  });
  const supervisor = {
    async request(command: SupervisorRequest["command"]) {
      requests.push(command);
      let transcript;
      if (command.type === "tab.agents")
        transcript = {
          tabId: tab.id,
          entries: [...journal.values()]
            .filter((entry) => entry.kind === "agent")
            .sort((a, b) => a.seq - b.seq),
          nextSeq: null,
        };
      if (command.type === "tab.transcript") {
        // Like the journal, transcript pages leave sub-agent cards out.
        const lead = [...journal.values()]
          .filter((entry) => entry.kind !== "agent")
          .sort((a, b) => a.seq - b.seq);
        if (command.afterSeq !== undefined) {
          const rows = lead.filter((entry) => entry.seq > command.afterSeq!);
          const limit = command.limit ?? 200;
          transcript = {
            tabId: tab.id,
            entries: rows.slice(0, limit),
            nextSeq: rows.length > limit ? rows[limit - 1].seq : null,
          };
        } else {
          const rows = lead.filter(
            (entry) => entry.seq < (command.beforeSeq ?? Infinity),
          );
          transcript = {
            tabId: tab.id,
            entries: rows.slice(-(command.limit ?? 200)),
            nextSeq: null,
          };
        }
      }
      return {
        ok: true as const,
        snapshot: snapshot(),
        ...(transcript ? { transcript } : {}),
      };
    },
  };
  let changes = 0;
  const publisher = new ReadAlongPublisher(
    collaboration as never,
    supervisor,
    () => changes++,
    1e9,
  );
  const entry = (
    seq: number,
    patch: Partial<TranscriptEntry> = {},
  ): TranscriptEntry => {
    const value: TranscriptEntry = {
      id: journal.get(seq)?.id ?? randomUUID(),
      tabId: tab.id,
      seq,
      turnId,
      kind: "assistant",
      share: "full",
      summary: `Entry ${seq} `,
      createdAt: stamp(),
      ...journal.get(seq),
      ...patch,
      updatedAt: stamp(),
    } as TranscriptEntry;
    journal.set(seq, value);
    return value;
  };
  // A sub-agent card entry: the summary is its task and the detail its final summary.
  const card = (
    seq: number,
    agent: Partial<AgentCard> = {},
    patch: Partial<TranscriptEntry> = {},
  ) =>
    entry(seq, {
      kind: "agent",
      summary: `Task ${seq}`,
      ...patch,
      agent: {
        key: `agent-${seq}`,
        status: "running",
        background: false,
        startedAt: "2026-09-26T00:00:00.000Z",
        toolUses: 0,
        ...journal.get(seq)?.agent,
        ...agent,
      },
    });
  const emit = (...entries: TranscriptEntry[]) =>
    publisher.acceptBatches([{ roomId, tabId: tab.id, entries }]);
  const publishes = () =>
    calls
      .filter((call) => call.name === "desktop_tab_share_publish")
      .map((call) => ({
        record: call.args.p_tab as PublishedRecord,
        entries: call.args.p_entries as PublishedEntry[],
      }));
  const flush = async () => {
    await publisher.flush(tab.id);
    await idle();
  };
  const local = () => publisher.acceptLocal(snapshot());
  return {
    tab,
    room,
    roomId,
    journal,
    calls,
    replies,
    requests,
    collaboration,
    publisher,
    extras,
    entry,
    card,
    emit,
    publishes,
    flush,
    local,
    changes: () => changes,
  };
}

test("only entries inside a window publish, projected and masked", async () => {
  const s = setup();
  s.local();
  await idle();
  s.emit(
    s.entry(1, {
      kind: "approval",
      share: "summary",
      state: "pending",
      summary: "Run ls",
    }),
    s.entry(2, { kind: "user", summary: "before" }),
    s.entry(3, {
      kind: "user",
      summary: "Deploy with sk-" + "proj4Vx9Qw2Lm8Rt5Zb1Nc7Hd3 please",
    }),
    s.entry(4, {
      kind: "reasoning",
      share: "none",
      summary: "private thoughts ",
    }),
    s.entry(5, {
      kind: "question",
      share: "none",
      state: "pending",
      summary: "Which file?",
    }),
    s.entry(6, {
      kind: "tool",
      share: "summary",
      agentKey: "task-1",
      summary: "sub tool",
    }),
    s.entry(7, {
      kind: "approval",
      share: "summary",
      agentKey: "task-1",
      state: "pending",
      summary: "sub asks",
    }),
    s.entry(8, {
      kind: "tool",
      share: "summary",
      summary:
        'curl -H "Authorization: Bearer abc123DEF456ghi789" https://api.test',
      detail: "raw output TOKEN=zzzzzzzzzzzz",
    }),
    s.entry(9, {
      kind: "notice",
      share: "full",
      notice: "signed_out",
      summary: "Signed out of alice@example.com\nDetails follow",
    }),
    s.entry(10, {
      kind: "plan",
      share: "full",
      state: "pending",
      summary: "Plan ready",
      detail: "1. Set PGPASSWORD=hunter2hunter2\n2. Ship",
    }),
  );
  // An update to an approval raised before switch-on stays private.
  s.emit(s.entry(1, { state: "accepted" }));
  await s.flush();
  const [first] = s.publishes();
  assert.deepEqual(
    first.entries.map((entry) => entry.seq),
    [3, 7, 8, 9, 10],
  );
  const bySeq = new Map(first.entries.map((entry) => [entry.seq, entry]));
  assert.equal(bySeq.get(3)!.text, "Deploy with sk-••• please");
  assert.deepEqual(Object.keys(bySeq.get(7)!).sort(), [
    "kind",
    "seq",
    "share",
    "state",
    "summary",
    "version",
  ]);
  assert.equal(
    bySeq.get(8)!.summary,
    'curl -H "Authorization: Bearer •••" https://api.test',
  );
  assert.equal(bySeq.get(8)!.detail, undefined);
  assert.deepEqual(bySeq.get(9), {
    seq: 9,
    kind: "notice",
    notice: "signed_out",
    share: "summary",
    summary: "Signed out of alice@example.com Details follow",
    version: 1,
  });
  assert.equal(bySeq.get(10)!.detail, "1. Set PGPASSWORD=•••\n2. Ship");
  for (const entry of first.entries)
    for (const key of Object.keys(entry))
      assert.ok(
        [
          "seq",
          "kind",
          "share",
          "state",
          "outcome",
          "notice",
          "summary",
          "text",
          "detail",
          "version",
        ].includes(key),
      );
  assert.equal(first.record.title, "Fix OPENAI_API_KEY=•••");
  assert.equal(first.record.deviceId, hostId);
  assert.equal(first.record.status, "running");
  s.publisher.close();
});

test("streaming text publishes its safe prefix, then the full masked text once complete", async () => {
  const s = setup();
  s.local();
  await idle();
  s.emit(s.entry(3, { summary: "Your key is ghp" + "_16C7e42F292c" }));
  await s.flush();
  assert.equal(s.publishes()[0].entries[0].text, "Your key is ");
  s.emit(
    s.entry(3, {
      summary: "Your key is ghp" + "_16C7e42F292c6912E7710c838347Ae178B4a",
    }),
  );
  await s.flush();
  // The key is still the last token, so nothing new is safe to publish.
  assert.equal(s.publishes().length, 1);
  s.emit(
    s.entry(4, {
      kind: "turn",
      share: "summary",
      outcome: "completed",
      summary: "Turn completed",
    }),
  );
  await s.flush();
  const full = s.publishes()[1].entries.find((entry) => entry.seq === 3)!;
  assert.equal(full.text, "Your key is ghp•••");
  assert.equal(full.version, 2);
  for (const publish of s.publishes())
    for (const entry of publish.entries)
      assert.ok(!entry.text?.includes("16C7e42F"));

  // A reply ending in a token with no later entry is released when the tab leaves running.
  s.emit(s.entry(5, { turnId: randomUUID(), summary: "Done" }));
  const count = s.publishes().length;
  await s.flush();
  assert.equal(s.publishes().length, count);
  s.tab.status = "idle";
  s.local();
  await s.flush();
  assert.equal(
    s
      .publishes()
      .at(-1)!
      .entries.find((entry) => entry.seq === 5)!.text,
    "Done",
  );
  assert.equal(s.publishes().at(-1)!.record.status, "idle");
  s.publisher.close();
});

test("ten deltas in one second coalesce, and a tick while a publish is in flight is skipped", async () => {
  const s = setup();
  s.local();
  await idle();
  let text = "";
  for (let index = 0; index < 10; index++) {
    text += `word${index} `;
    s.emit(s.entry(3, { summary: text }));
  }
  let release!: () => void;
  const original = s.collaboration.readAlong.bind(s.collaboration);
  s.collaboration.readAlong = async <T>(
    name: string,
    args: Record<string, unknown>,
  ) => {
    await new Promise<void>((resolve) => (release = resolve));
    return original<T>(name, args);
  };
  const pending = s.publisher.flush(s.tab.id);
  await idle();
  await s.publisher.flush(s.tab.id);
  release();
  await pending;
  assert.equal(s.publishes().length, 1);
  assert.equal(s.publishes()[0].entries.length, 1);
  assert.equal(s.publishes()[0].entries[0].text, text);
  s.publisher.close();
});

test("an approval publishes pending, then cancelled with a higher version after Stop", async () => {
  const s = setup();
  s.local();
  await idle();
  s.emit(
    s.entry(3, {
      kind: "approval",
      share: "summary",
      state: "pending",
      summary: "Run rm",
    }),
  );
  await s.flush();
  s.emit(s.entry(4, { kind: "tool", share: "summary", summary: "ls" }));
  await s.flush();
  s.emit(s.entry(3, { state: "cancelled" }));
  s.tab.status = "idle";
  s.local();
  await s.flush();
  const [pending, newer, cancelled] = s.publishes();
  assert.deepEqual(
    pending.entries.map((entry) => [entry.seq, entry.state, entry.version]),
    [[3, "pending", 1]],
  );
  assert.deepEqual(
    newer.entries.map((entry) => entry.seq),
    [4],
  );
  assert.deepEqual(
    cancelled.entries.map((entry) => [entry.seq, entry.state, entry.version]),
    [[3, "cancelled", 2]],
  );
  s.publisher.close();
});

test("switch off publishes the paused notice from the closed window, then ended; close publishes closed", async () => {
  const s = setup();
  s.local();
  await idle();
  s.emit(s.entry(3, { kind: "user", summary: "Hi" }));
  await s.flush();
  // The supervisor's snapshot closing the window arrives before this flush.
  s.tab.readAlong = false;
  s.tab.readAlongWindows = [{ onSeq: 3, offSeq: 5 }];
  s.local();
  s.emit(
    s.entry(4, { kind: "notice", turnId: null, summary: "Read-along paused." }),
  );
  await s.flush();
  const ended = s.publishes().at(-1)!;
  assert.deepEqual(
    ended.entries.map((entry) => entry.summary),
    ["Read-along paused."],
  );
  assert.equal(ended.record.status, "ended");
  assert.equal(ended.record.switchOn, false);
  s.emit(s.entry(5, { kind: "user", summary: "Private" }));
  await s.flush();
  assert.equal(s.publishes().length, 2);
  s.room.tabs = [];
  s.local();
  await idle();
  assert.equal(s.publishes().at(-1)!.record.status, "closed");
  assert.deepEqual(s.publisher.status(), {});
  s.publisher.close();
});

test("offline entries buffer, then publish once in order after the head on reconnect", async () => {
  const s = setup();
  s.local();
  await idle();
  s.emit(s.entry(3, { kind: "user", summary: "One" }));
  await s.flush();
  s.collaboration.state.status = "offline" as never;
  s.publisher.collaborationChanged();
  s.emit(s.entry(4, { kind: "tool", share: "summary", summary: "ls" }));
  s.emit(s.entry(5, { kind: "tool", share: "summary", summary: "pwd" }));
  for (let tick = 0; tick < 3; tick++) await s.flush();
  assert.equal(s.publishes().length, 1);
  assert.deepEqual(s.publisher.status()[s.tab.id], {
    state: "paused",
    buffered: 2,
  });
  // A second tab closed while offline is absent from the reconcile list.
  s.replies.desktop_tab_share_head = [
    { ok: true, data: { maxSeq: 3, version: 1, rev: 1, pending: [] } },
  ];
  s.collaboration.state.status = "connected";
  s.publisher.collaborationChanged();
  await idle();
  const reconcile = s.calls
    .filter((call) => call.name === "desktop_tab_share_reconcile")
    .at(-1)!;
  assert.deepEqual(reconcile.args.p_live_tab_ids, [s.tab.id]);
  await s.flush();
  const replay = s
    .publishes()
    .slice(1)
    .flatMap((publish) => publish.entries);
  assert.deepEqual(
    replay.map((entry) => entry.seq),
    [3, 4, 5],
  );
  assert.equal(replay[0].version, 2);
  assert.deepEqual(s.publisher.status()[s.tab.id], { state: "publishing" });
  s.publisher.close();
});

test("after a relaunch the head and pending approvals republish above their stored versions", async () => {
  const s = setup();
  s.entry(3, {
    kind: "approval",
    share: "summary",
    state: "cancelled",
    summary: "Run rm",
  });
  s.entry(4, { summary: "A reply that grew while offline " });
  s.entry(5, {
    kind: "notice",
    turnId: null,
    notice: "interrupted",
    summary: "The app restarted.",
  });
  s.tab.status = "interrupted";
  s.replies.desktop_tab_share_head = [
    {
      ok: true,
      data: {
        maxSeq: 4,
        version: 7,
        rev: 9,
        pending: [{ seq: 3, version: 2 }],
      },
    },
  ];
  // Signed in before the supervisor's first snapshot: nothing is reconciled yet.
  s.publisher.collaborationChanged();
  await idle();
  assert.equal(s.calls.length, 0);
  s.local();
  await idle();
  assert.deepEqual(s.calls.map((call) => call.name).slice(0, 2), [
    "desktop_tab_share_reconcile",
    "desktop_tab_share_head",
  ]);
  await s.flush();
  const [publish] = s.publishes();
  assert.deepEqual(
    publish.entries.map((entry) => [entry.seq, entry.version]),
    [
      [3, 3],
      [4, 8],
      [5, 1],
    ],
  );
  assert.equal(publish.entries[0].state, "cancelled");
  assert.equal(publish.record.status, "interrupted");
  s.tab.status = "running";
  s.local();
  await s.flush();
  assert.equal(s.publishes().at(-1)!.record.status, "running");
  s.publisher.close();
});

test("losing membership turns the switch off directly, discards staged entries, and publishes nothing from the gap", async () => {
  const s = setup();
  s.local();
  await idle();
  s.emit(s.entry(3, { kind: "user", summary: "Staged" }));
  s.replies.desktop_tab_share_publish = [{ ok: false, reason: "not_member" }];
  const before = structuredClone(s.collaboration.state);
  await s.flush();
  assert.deepEqual(s.requests.at(-1), {
    type: "tab.setReadAlong",
    roomId: s.roomId,
    tabId: s.tab.id,
    on: false,
    discard: true,
  });
  assert.deepEqual(s.publisher.status()[s.tab.id], {
    state: "stopped",
    reason: "not_member",
  });
  assert.equal(s.collaboration.refreshes, 1);
  assert.deepEqual(s.collaboration.state, before);
  s.tab.readAlong = false;
  s.tab.readAlongWindows = [{ onSeq: 3, offSeq: 3 }];
  s.local();
  s.emit(s.entry(4, { kind: "user", summary: "Gap" }));
  await s.flush();
  // Re-invited and switched on again: only the new window publishes.
  s.tab.readAlong = true;
  s.tab.readAlongWindows = [
    { onSeq: 3, offSeq: 3 },
    { onSeq: 5, offSeq: null },
  ];
  s.local();
  await idle();
  s.emit(
    s.entry(5, {
      kind: "notice",
      turnId: null,
      summary: "Read-along resumed.",
    }),
  );
  await s.flush();
  // The rejected publish carried seq 3; nothing after it does.
  const published = s
    .publishes()
    .slice(1)
    .flatMap((publish) => publish.entries.map((entry) => entry.seq));
  assert.deepEqual(published, [5]);
  assert.deepEqual(s.publisher.status()[s.tab.id], { state: "publishing" });
  s.publisher.close();
});

test("a room missing from the connected list stops sharing like a 42501", async () => {
  const s = setup();
  s.local();
  await idle();
  s.collaboration.rooms = [];
  s.publisher.collaborationChanged();
  await idle();
  assert.equal(s.requests.at(-1)?.type, "tab.setReadAlong");
  s.publisher.close();
});

test("record status follows the tab, rename republishes, and epoch changes drop staged work", async () => {
  const base = setup().tab;
  assert.equal(
    recordStatus({ ...base, status: "idle", agentRequests: 1 }),
    "awaiting_host",
  );
  assert.equal(
    recordStatus({ ...base, status: "resume_failed" }),
    "interrupted",
  );
  assert.equal(recordStatus({ ...base, readAlong: false }), "ended");
  assert.equal(recordStatus(undefined), "closed");
  const s = setup();
  s.local();
  await idle();
  await s.flush();
  s.tab.title = "Renamed";
  s.local();
  await s.flush();
  assert.equal(s.publishes().at(-1)!.record.title, "Renamed");
  s.emit(s.entry(3, { kind: "user", summary: "Staged" }));
  s.collaboration.currentEpoch = 2;
  s.collaboration.state.auth = "signed_out" as never;
  s.publisher.collaborationChanged();
  const count = s.publishes().length;
  await s.flush();
  assert.equal(s.publishes().length, count);
  s.publisher.close();
});

test("a migration missing from the project stops that tab only", async () => {
  const s = setup();
  s.local();
  await idle();
  s.emit(s.entry(3, { kind: "user", summary: "Hi" }));
  s.replies.desktop_tab_share_publish = [
    { ok: false, reason: "migration_missing" },
  ];
  await s.flush();
  assert.deepEqual(s.publisher.status()[s.tab.id], {
    state: "stopped",
    reason: "migration_missing",
  });
  assert.equal(s.collaboration.state.status, "connected");
  s.publisher.close();
});

test("an update stamped in the same millisecond still replaces the held entry", async () => {
  const s = setup();
  s.local();
  await idle();
  const first = s.entry(3, { summary: "Partial " });
  s.emit(first);
  s.emit({ ...first, summary: "Partial and final " });
  await s.flush();
  assert.equal(s.publishes()[0].entries[0].text, "Partial and final ");
  s.publisher.close();
});

test("closing publishes the held entries in their final state with the closed record", async () => {
  const s = setup();
  s.local();
  await idle();
  s.emit(s.entry(3, { summary: "Streaming reply ends here" }));
  s.room.tabs = [];
  s.local();
  await idle();
  const closing = s.publishes().at(-1)!;
  assert.equal(closing.record.status, "closed");
  assert.deepEqual(
    closing.entries.map((entry) => entry.text),
    ["Streaming reply ends here"],
  );
  s.publisher.close();
});

test("text past the writer's clamp stops updating instead of shifting", async () => {
  const s = setup();
  s.local();
  await idle();
  const head = "a ".repeat(99_999);
  s.emit(s.entry(3, { summary: head }));
  await s.flush();
  const published = s.publishes()[0].entries[0].text;
  // The writer now keeps only the tail, so the start moves.
  s.emit(s.entry(3, { summary: ("b " + head).slice(-200_000) + "more " }));
  await s.flush();
  assert.equal(s.publishes().length, 1);
  assert.equal(published, head);
  s.publisher.close();
});

const SECRET = "OPENAI_API_KEY=q8Zr2mVx4TnL7pWc";
const published = (s: ReturnType<typeof setup>) =>
  s.publishes().flatMap((publish) => publish.entries);
const leaked = (s: ReturnType<typeof setup>) =>
  JSON.stringify(s.calls).includes("q8Zr2mVx4TnL7pWc");

test("a card inside a window publishes running, then completed with its masked summary", async () => {
  const s = setup();
  s.local();
  await idle();
  // Covers AE2, AE4: the card, and nothing a sub-agent itself produced.
  s.emit(
    s.card(
      3,
      { name: "explorer", type: "Explore", parentKey: "lead" },
      { summary: `Find the key ${SECRET}` },
    ),
    s.entry(4, { kind: "reasoning", share: "none", agentKey: "agent-3" }),
    s.entry(5, { kind: "tool", share: "summary", agentKey: "agent-3" }),
    s.entry(6, { kind: "assistant", agentKey: "agent-3", summary: "Hi" }),
    s.entry(7, { kind: "user", agentKey: "agent-3", summary: "Prompt" }),
  );
  await s.flush();
  assert.deepEqual(published(s), [
    {
      seq: 3,
      kind: "agent",
      share: "full",
      summary: "Find the key OPENAI_API_KEY=•••",
      agent: {
        key: "agent-3",
        parentKey: "lead",
        name: "explorer",
        type: "Explore",
        status: "running",
        background: false,
        startedAt: "2026-09-26T00:00:00.000Z",
        toolUses: 0,
        turnId,
      },
      version: 1,
    },
  ]);
  // A tool use, then a summary still being written: only its safe prefix leaves the host.
  s.emit(
    s.card(
      3,
      { toolUses: 1, latestTool: `curl -H "x-api-key: q8Zr2mVx4TnL7pWc"` },
      { detail: "Found it. OPENAI_API_KEY=q8Zr2m" },
    ),
  );
  await s.flush();
  const partial = published(s).at(-1)!;
  assert.equal(partial.version, 2);
  assert.equal(partial.text, "Found it. ");
  assert.equal(partial.agent?.latestTool, 'curl -H "x-api-key: •••"');
  s.emit(
    s.card(
      3,
      { status: "completed", endedAt: "2026-09-26T00:01:00.000Z" },
      { detail: `Found it. ${SECRET} in .env` },
    ),
  );
  await s.flush();
  const done = published(s).at(-1)!;
  assert.equal(done.version, 3);
  assert.equal(done.agent?.status, "completed");
  assert.equal(done.agent?.endedAt, "2026-09-26T00:01:00.000Z");
  assert.equal(done.text, "Found it. OPENAI_API_KEY=••• in .env");
  assert.equal(published(s).length, 3);
  assert.equal(leaked(s), false);
  s.publisher.close();
});

test("a long task masks before it is cut and never fails the batch", async () => {
  const s = setup();
  s.local();
  await idle();
  // The credential straddles character 400 of a 2,000-character task.
  const task = `${"a".repeat(388)} ${SECRET} ${"b".repeat(1_580)}`;
  s.emit(
    s.card(
      3,
      { name: `n ${SECRET}`, type: `t ${SECRET}`, latestTool: `l ${SECRET}` },
      { summary: task },
    ),
  );
  await s.flush();
  const [entry] = published(s);
  assert.equal(entry.summary.length, 400);
  assert.ok(entry.summary.endsWith(" OPENAI_API…"));
  assert.equal(entry.agent?.name, "n OPENAI_API_KEY=•••");
  assert.equal(entry.agent?.type, "t OPENAI_API_KEY=•••");
  assert.equal(entry.agent?.latestTool, "l OPENAI_API_KEY=•••");
  assert.equal(leaked(s), false);
  assert.ok(!/q8Z/.test(JSON.stringify(s.calls)));
  s.publisher.close();
});

test("a sub-agent running when the window opens joins mid-run; a finished one stays private", async () => {
  const s = setup({ windows: [] });
  s.tab.readAlong = false;
  s.local();
  await idle();
  s.card(1, { status: "completed" }, { detail: "Done before" });
  s.card(2, { toolUses: 4, latestTool: "Read notes.txt" });
  // Covers AE5: the switch goes on while agent-2 runs.
  s.tab.readAlong = true;
  s.tab.readAlongWindows = [{ onSeq: 5, offSeq: null }];
  s.local();
  await idle();
  assert.equal(
    s.requests.filter((command) => command.type === "tab.agents").length,
    1,
  );
  await s.flush();
  assert.deepEqual(
    published(s).map((entry) => [entry.seq, entry.agent?.joinedMidRun]),
    [[2, true]],
  );
  // Work from before the switch stays private.
  assert.equal(published(s)[0].agent?.latestTool, undefined);
  assert.equal(published(s)[0].agent?.status, "running");
  // Later updates publish although the card sits before the window, and the fetch ran once.
  s.emit(s.card(2, { toolUses: 5, latestTool: "Edit notes.txt" }));
  s.emit(s.card(1, {}, { detail: "Changed" }));
  await s.flush();
  s.emit(s.card(2, { status: "completed" }, { detail: "All done" }));
  await s.flush();
  assert.deepEqual(
    published(s).map((entry) => [
      entry.seq,
      entry.version,
      entry.agent?.status,
      entry.agent?.latestTool,
      entry.text,
    ]),
    [
      [2, 1, "running", undefined, undefined],
      [2, 2, "running", "Edit notes.txt", undefined],
      [2, 3, "completed", "Edit notes.txt", "All done"],
    ],
  );
  assert.ok(published(s).every((entry) => entry.agent?.joinedMidRun));
  assert.equal(
    s.requests.filter((command) => command.type === "tab.agents").length,
    1,
  );
  s.publisher.close();
});

test("after the switch goes off no card update publishes and the record reads ended", async () => {
  const s = setup();
  s.extras.harnesses = [{ id: "codex", reportsAgents: true } as HarnessState];
  s.tab.runningAgents = 1;
  s.local();
  await idle();
  s.emit(s.card(3));
  await s.flush();
  assert.equal(s.publishes().at(-1)!.record.runningAgents, 1);
  // Covers AE6.
  s.tab.readAlong = false;
  s.tab.readAlongWindows = [{ onSeq: 3, offSeq: 4 }];
  s.tab.runningAgents = 0;
  s.local();
  s.emit(s.card(3, { status: "completed" }, { detail: "Finished later" }));
  await s.flush();
  const ended = s.publishes().at(-1)!;
  assert.equal(ended.record.status, "ended");
  assert.deepEqual(ended.entries, []);
  // The ended record leaves the plan fields out, so the server keeps what was last shared.
  assert.equal("plan" in ended.record, false);
  assert.equal("runningAgents" in ended.record, false);
  assert.equal("reportsAgents" in ended.record, false);
  assert.equal(published(s).length, 1);
  // Switching back on refreshes the card the viewers still see as running.
  s.tab.readAlong = true;
  s.tab.readAlongWindows = [
    { onSeq: 3, offSeq: 4 },
    { onSeq: 9, offSeq: null },
  ];
  s.local();
  await idle();
  await s.flush();
  const refreshed = published(s).at(-1)!;
  assert.deepEqual(
    [refreshed.seq, refreshed.version, refreshed.agent?.status],
    [3, 2, "completed"],
  );
  assert.equal(refreshed.agent?.joinedMidRun, undefined);
  s.publisher.close();
});

test("a waiting sub-agent publishes awaiting_host and its approval as a summary", async () => {
  const s = setup();
  s.local();
  await idle();
  // Covers AE7.
  s.tab.agentRequests = 1;
  s.local();
  s.emit(
    s.card(3),
    s.entry(4, {
      kind: "approval",
      share: "summary",
      state: "pending",
      agentKey: "agent-3",
      summary: `Run deploy --password hunter2hunter2`,
      detail: "local only",
    }),
  );
  await s.flush();
  const publish = s.publishes().at(-1)!;
  assert.equal(publish.record.status, "awaiting_host");
  assert.deepEqual(publish.entries[1], {
    seq: 4,
    kind: "approval",
    state: "pending",
    share: "summary",
    summary: "Run deploy --password •••",
    version: 1,
  });
  s.publisher.close();
});

test("the record carries the masked plan, the running count, and whether agents are reported", async () => {
  const s = setup();
  s.local();
  await idle();
  await s.flush();
  // No harness state in the snapshot: null, never a guess.
  assert.deepEqual(
    [
      s.publishes().at(-1)!.record.plan,
      s.publishes().at(-1)!.record.runningAgents,
      s.publishes().at(-1)!.record.reportsAgents,
    ],
    [null, 0, null],
  );
  s.extras.harnesses = [{ id: "codex", reportsAgents: false } as HarnessState];
  s.tab.runningAgents = 2;
  s.tab.plan = {
    turnId,
    explanation: `Use ${SECRET}`,
    steps: [
      { text: `Export ${SECRET}\nthen go`, status: "done" },
      { text: "x".repeat(400), status: "active" },
      ...Array.from({ length: 60 }, () => ({
        text: "More",
        status: "pending" as const,
      })),
    ],
    updatedAt: stamp(),
  };
  s.local();
  await s.flush();
  const { record } = s.publishes().at(-1)!;
  assert.equal(record.runningAgents, 2);
  assert.equal(record.reportsAgents, false);
  assert.equal(record.plan?.explanation, "Use OPENAI_API_KEY=•••");
  assert.equal(record.plan?.steps.length, 50);
  assert.deepEqual(record.plan?.steps[0], {
    text: "Export OPENAI_API_KEY=••• then go",
    status: "done",
  });
  assert.equal(record.plan?.steps[1].text.length, 300);
  assert.equal(leaked(s), false);
  // A changed count or harness state republishes the record on the next tick.
  const before = s.publishes().length;
  s.tab.runningAgents = 1;
  s.extras.harnesses = [{ id: "codex", reportsAgents: true } as HarnessState];
  s.local();
  await s.flush();
  assert.equal(s.publishes().length, before + 1);
  assert.equal(s.publishes().at(-1)!.record.runningAgents, 1);
  assert.equal(s.publishes().at(-1)!.record.reportsAgents, true);
  assert.equal(projectPlan(undefined), null);
  assert.equal(
    projectPlan({ turnId: null, steps: [], updatedAt: stamp() }),
    null,
  );
  s.publisher.close();
});

test("a relaunch republishes cards that settled while away and leaves unchanged ones alone", async () => {
  const s = setup({ windows: [{ onSeq: 3, offSeq: null }] });
  // Before the window and running when it opened, published mid-run, settled while away.
  s.card(
    2,
    { status: "interrupted" },
    { detail: "Interrupted before finishing" },
  );
  s.card(3, { status: "completed" }, { detail: "Unchanged" });
  // Published running, settled while the host app was down.
  s.card(
    4,
    { status: "interrupted" },
    { detail: "Interrupted before finishing" },
  );
  s.entry(5, { summary: "Head" });
  // Filed after the head: the server has not seen it.
  s.card(6, { status: "completed" }, { detail: "New" });
  s.replies.desktop_tab_share_head = [
    {
      ok: true,
      data: {
        maxSeq: 5,
        version: 1,
        rev: 9,
        pending: [
          { seq: 2, version: 4 },
          { seq: 4, version: 6 },
        ],
      },
    },
  ];
  s.tab.status = "interrupted";
  s.local();
  await idle();
  await s.flush();
  assert.deepEqual(
    published(s).map((entry) => [
      entry.seq,
      entry.version,
      entry.agent?.status,
      entry.agent?.joinedMidRun,
    ]),
    [
      [2, 5, "interrupted", true],
      [4, 7, "interrupted", undefined],
      [5, 2, undefined, undefined],
      [6, 1, "completed", undefined],
    ],
  );
  s.publisher.close();
});

test("a mid-run card still completes after a relaunch rebuilds the key set", async () => {
  const s = setup({ windows: [{ onSeq: 3, offSeq: null }] });
  // Main restarted while the supervisor kept the sub-agent running.
  s.card(2);
  s.replies.desktop_tab_share_head = [
    {
      ok: true,
      data: {
        maxSeq: 2,
        version: 3,
        rev: 9,
        pending: [{ seq: 2, version: 3 }],
      },
    },
  ];
  s.local();
  await idle();
  await s.flush();
  s.emit(s.card(2, { status: "completed" }, { detail: "Done" }));
  await s.flush();
  const done = published(s).at(-1)!;
  assert.deepEqual(
    [done.seq, done.agent?.status, done.agent?.joinedMidRun, done.text],
    [2, "completed", true, "Done"],
  );
  assert.ok(done.version > 3);
  s.publisher.close();
});

test("a database that refuses cards keeps publishing the transcript without them", async () => {
  const s = setup();
  s.local();
  await idle();
  s.emit(s.entry(3, { kind: "user", summary: "Go" }), s.card(4));
  s.replies.desktop_tab_share_publish = [{ ok: false, reason: "invalid" }];
  await s.flush();
  await s.flush();
  s.emit(s.card(4, { toolUses: 1 }), s.card(5));
  await s.flush();
  assert.deepEqual(
    s.publishes().map((publish) => publish.entries.map((entry) => entry.seq)),
    [[3, 4], [3]],
  );
  assert.deepEqual(s.publisher.status()[s.tab.id], { state: "publishing" });
  s.publisher.close();
});
