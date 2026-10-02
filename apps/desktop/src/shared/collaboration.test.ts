import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  asSharedRoom,
  sharedPullSchema,
  sharedSnapshotSchema,
} from "./collaboration";

const room = () => ({
  id: randomUUID(),
  name: "Shared",
  slug: "shared",
  createdAt: "now",
  isAdmin: false,
  members: [],
  messages: [],
  suggestions: [],
});

test("snapshots parse with and without read-along rows and server time", () => {
  const userId = randomUUID();
  const old = sharedSnapshotSchema.parse({
    version: 1,
    userId,
    rooms: [room()],
  });
  assert.equal(old.now, undefined);
  assert.deepEqual(
    asSharedRoom(old.rooms[0], userId, "p").shared?.sharedTabs,
    [],
  );
  const tab = {
    tabId: randomUUID(),
    roomId: randomUUID(),
    hostId: randomUUID(),
    hostName: "Alice",
    deviceId: randomUUID(),
    title: "Fix the build",
    harness: "codex",
    model: "gpt-5",
    status: "running",
    switchOn: true,
    rev: 3,
    updatedAt: "2026-09-26T00:00:00Z",
  };
  const current = sharedSnapshotSchema.parse({
    version: 1,
    userId,
    now: "2026-09-26T00:00:01Z",
    rooms: [{ ...room(), sharedTabs: [tab, { ...tab, status: "paused" }] }],
  });
  assert.equal(current.now, "2026-09-26T00:00:01Z");
  // A malformed row is dropped without failing the snapshot.
  assert.deepEqual(
    asSharedRoom(current.rooms[0], userId, "p").shared?.sharedTabs,
    [tab],
  );
});

test("pull pages accept fields a newer server adds and a host without a name", () => {
  const record = {
    tabId: randomUUID(),
    roomId: randomUUID(),
    hostId: randomUUID(),
    hostName: null,
    deviceId: randomUUID(),
    title: "Tab",
    harness: "codex",
    model: "m",
    status: "idle",
    switchOn: true,
    rev: 1,
    updatedAt: "now",
  };
  const page = sharedPullSchema.parse({
    record,
    entries: [],
    next: null,
    now: "now",
    addedLater: true,
  });
  assert.equal(page.record.hostName, "A member");
  // Rows stay strict.
  assert.equal(
    sharedPullSchema.safeParse({
      record,
      entries: [
        {
          seq: 1,
          kind: "user",
          share: "full",
          summary: "s",
          version: 1,
          rev: 1,
          updatedAt: "now",
          agentKey: "leak",
        },
      ],
      next: null,
      now: "now",
    }).success,
    false,
  );
});

test("pull pages parse sub-agent cards and the record's plan fields", () => {
  const record = {
    tabId: randomUUID(),
    roomId: randomUUID(),
    hostId: randomUUID(),
    hostName: "Alice",
    deviceId: randomUUID(),
    title: "Tab",
    harness: "claude",
    model: "m",
    status: "running",
    switchOn: true,
    rev: 1,
    updatedAt: "now",
  };
  const card = {
    seq: 2,
    kind: "agent",
    share: "full",
    summary: "Map the codebase",
    text: "Found it",
    agent: {
      key: "agent-1",
      status: "completed",
      background: false,
      startedAt: "then",
      endedAt: "now",
      toolUses: 3,
      latestTool: "Read a file",
      joinedMidRun: true,
      turnId: randomUUID(),
    },
    version: 2,
    rev: 4,
    updatedAt: "now",
  };
  const parse = (patch: object, entry: object = card) =>
    sharedPullSchema.safeParse({
      record: { ...record, ...patch },
      entries: [entry],
      next: null,
      now: "now",
    });
  // An older database omits the record fields; an older host stores them as null.
  const old = parse({});
  assert.equal(old.data?.record.reportsAgents, undefined);
  assert.deepEqual(old.data?.entries[0].agent, card.agent);
  assert.equal(
    parse({ plan: null, runningAgents: null, reportsAgents: null }).data?.record
      .reportsAgents,
    null,
  );
  const plan = { steps: [{ text: "Read", status: "active" }] };
  const current = parse({ plan, runningAgents: 2, reportsAgents: false });
  assert.deepEqual(current.data?.record.plan, plan);
  assert.equal(current.data?.record.runningAgents, 2);
  assert.equal(current.data?.record.reportsAgents, false);
  // Rows stay strict: unknown card fields, bad enums, and cards on the wrong kind fail.
  for (const bad of [
    { ...card, agent: { ...card.agent, model: "leak" } },
    { ...card, agent: { ...card.agent, status: "paused" } },
    { ...card, agent: { ...card.agent, turnId: "nope" } },
    { ...card, agent: undefined },
    { ...card, kind: "assistant" },
  ])
    assert.equal(parse({}, bad).success, false);
  assert.equal(
    parse({ plan: { steps: [{ text: "x", status: "blocked" }] } }).success,
    false,
  );
});
