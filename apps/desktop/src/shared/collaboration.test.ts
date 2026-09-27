import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asSharedRoom, sharedSnapshotSchema } from "./collaboration";

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
