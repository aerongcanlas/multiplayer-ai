import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DesktopCoordinator } from "./coordinator";
import { signedOutState } from "../shared/collaboration";
import type { Snapshot, Room, Result } from "../shared/contracts";

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

test("shared generation rejects duplicate requests and discards results after an account switch", async () => {
  const userId = randomUUID();
  const room: Room = {
    id: randomUUID(),
    name: "Shared",
    createdAt: new Date().toISOString(),
    workspace: null,
    executions: [],
    summaries: [],
    messages: [],
    suggestions: [],
    shared: { userId, project: "test", isAdmin: true, members: [] },
  };
  const local: Snapshot = {
    protocolVersion: 1,
    sync: "local-only",
    revision: 1,
    hostId: randomUUID(),
    rooms: [room],
  };
  let finish!: (result: Result) => void;
  let started!: () => void;
  const generating = new Promise<void>((resolve) => {
    started = resolve;
  });
  let saves = 0;
  const shared = {
    rooms: [room],
    state: {
      ...signedOutState(),
      auth: "signed_in" as const,
      status: "connected" as const,
      account: { id: userId, name: "Alice" },
    },
    command: async () => {
      saves++;
      return undefined;
    },
    refresh: async () => {},
    signIn: async () => {},
    signOut: async () => {},
    cancelSignIn: async () => {},
  };
  const coordinator = new DesktopCoordinator(
    {
      request: async (command) => {
        if (command.type === "suggestion.create") {
          started();
          return new Promise<Result>((resolve) => {
            finish = resolve;
          });
        }
        return { ok: true, snapshot: local };
      },
    },
    shared,
    () => {},
    async () => null,
  );
  coordinator.acceptLocal(local);
  const command = {
    type: "suggestion.create" as const,
    roomId: room.id,
    messageIds: [randomUUID()],
  };
  const pending = coordinator.dispatch(command);
  await generating;
  assert.deepEqual(await coordinator.dispatch(command), {
    ok: false,
    error: "Prompt generation is already in progress.",
  });
  shared.state.account = { id: randomUUID(), name: "Bob" };
  shared.rooms = [];
  finish({ ok: true, snapshot: local });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(saves, 0);
  assert.deepEqual(coordinator.snapshot()?.rooms, []);
});
