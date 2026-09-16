import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DesktopCoordinator } from "./coordinator";
import { signedOutState } from "../shared/collaboration";
import type { Snapshot, Room } from "../shared/contracts";

test("projection ignores delayed local replies and hides cached shared rooms from another account", () => {
  const userId = randomUUID();
  const cached: Room = {
    id: randomUUID(),
    name: "Private shared content",
    createdAt: new Date().toISOString(),
    shared: { userId, project: "test", isAdmin: true, members: [] },
    workspace: {
      id: randomUUID(),
      name: "Private repo",
      branch: "main",
      revision: "abc",
      dirty: false,
    },
    executions: [],
    summaries: [],
    messages: [],
    suggestions: [],
  };
  const local: Snapshot = {
    protocolVersion: 1,
    sync: "local-only",
    revision: 10,
    hostId: randomUUID(),
    rooms: [cached],
  };
  const shared = {
    rooms: [] as Room[],
    state: signedOutState(),
    command: async () => undefined,
    refresh: async () => {},
    signIn: async () => {},
    signOut: async () => {},
    cancelSignIn: async () => {},
  };
  const coordinator = new DesktopCoordinator(
    { request: async () => ({ ok: true, snapshot: local }) },
    shared,
    () => {},
    async () => null,
  );
  coordinator.acceptLocal(local);
  assert.deepEqual(coordinator.snapshot()?.rooms, []);
  shared.rooms = [{ ...cached, workspace: null }];
  coordinator.changed();
  assert.equal(
    coordinator.snapshot()?.rooms[0].workspace?.name,
    "Private repo",
  );
  const revision = coordinator.snapshot()!.revision;
  coordinator.acceptLocal({ ...local, revision: 9, rooms: [] });
  assert.equal(coordinator.snapshot()?.revision, revision);
  assert.equal(
    coordinator.snapshot()?.rooms[0].workspace?.name,
    "Private repo",
  );
  shared.rooms = [
    {
      ...cached,
      shared: { ...cached.shared!, userId: randomUUID() },
      workspace: null,
    },
  ];
  coordinator.changed();
  assert.equal(coordinator.snapshot()?.rooms[0].workspace, null);
  shared.rooms = [];
  coordinator.changed();
  assert.deepEqual(coordinator.snapshot()?.rooms, []);
});
