import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DesktopCoordinator } from "./coordinator";
import { signedOutState } from "../shared/collaboration";
import type { Snapshot, Room, SupervisorRequest } from "../shared/contracts";
import type { Tab } from "../shared/tabs";

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
    tabs: [],
    messages: [],
    suggestions: [],
  };
  const local: Snapshot = {
    protocolVersion: 2,
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

const tabRoom = (userId: string, status: Tab["status"] = "idle"): Room => {
  const roomId = randomUUID();
  return {
    id: roomId,
    name: "Shared",
    createdAt: new Date().toISOString(),
    shared: { userId, project: "test", isAdmin: true, members: [] },
    workspace: null,
    messages: [],
    suggestions: [],
    tabs: [
      {
        id: randomUUID(),
        roomId,
        title: "Codex 1",
        loadout: {
          harness: "codex",
          model: "m",
          planMode: false,
          access: "ask",
        },
        status,
        readAlong: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  };
};

function sharedSetup(
  room: Room,
  refresh: () => Promise<void> = async () => {},
) {
  const local: Snapshot = {
    protocolVersion: 2,
    sync: "local-only",
    revision: 1,
    hostId: randomUUID(),
    rooms: [room],
  };
  const requests: SupervisorRequest["command"][] = [];
  const shared = {
    rooms: [{ ...room, tabs: [] as Tab[] }],
    state: { ...signedOutState(), status: "connected" as const },
    command: async () => undefined,
    refresh,
    signIn: async () => {},
    signOut: async () => {},
    cancelSignIn: async () => {},
  };
  const coordinator = new DesktopCoordinator(
    {
      request: async (command) => {
        requests.push(command);
        return { ok: true, snapshot: local };
      },
    },
    shared,
    () => {},
    async () => null,
    async () => "/opt/codex",
  );
  coordinator.acceptLocal(local);
  return { coordinator, requests, shared };
}

test("tab.send in a shared room refreshes, imports, and checks membership first", async () => {
  const userId = randomUUID();
  const room = tabRoom(userId);
  const tabId = room.tabs[0].id;
  const { coordinator, requests, shared } = sharedSetup(room);
  // The view keeps the host's local tabs over the shared projection.
  assert.equal(coordinator.snapshot()?.rooms[0].tabs[0].id, tabId);
  const send = {
    type: "tab.send" as const,
    roomId: room.id,
    tabId,
    text: "Hello",
  };
  assert.equal((await coordinator.dispatch(send)).ok, true);
  assert.deepEqual(
    requests.map((request) => request.type),
    ["shared.import", "tab.send"],
  );
  shared.rooms = [];
  const refused = await coordinator.dispatch(send);
  assert.equal(refused.ok, false);
});

test("Stop and approval responses reach the supervisor while the shared refresh fails", async () => {
  const room = tabRoom(randomUUID(), "awaiting_host");
  const tabId = room.tabs[0].id;
  const { coordinator, requests } = sharedSetup(room, async () => {
    throw new Error("offline");
  });
  for (const command of [
    { type: "tab.stop" as const, roomId: room.id, tabId },
    {
      type: "approval.respond" as const,
      roomId: room.id,
      tabId,
      approvalId: randomUUID(),
      decision: "decline" as const,
    },
    { type: "tab.transcript" as const, roomId: room.id, tabId },
    { type: "tab.agents" as const, roomId: room.id, tabId },
  ])
    assert.equal((await coordinator.dispatch(command)).ok, true);
  assert.deepEqual(
    requests.map((request) => request.type),
    ["tab.stop", "approval.respond", "tab.transcript", "tab.agents"],
  );
  assert.equal(
    (
      await coordinator.dispatch({
        type: "tab.send",
        roomId: room.id,
        tabId,
        text: "Hello",
      })
    ).ok,
    false,
  );
});

test("harness commands go straight to the supervisor and executable paths come from main's dialog", async () => {
  const room = tabRoom(randomUUID());
  const { coordinator, requests } = sharedSetup(room);
  await coordinator.dispatch({ type: "harness.refresh", harness: "codex" });
  await coordinator.dispatch({
    type: "harness.chooseExecutable",
    harness: "codex",
  });
  assert.deepEqual(requests, [
    { type: "harness.refresh", harness: "codex" },
    { type: "harness.setExecutable", harness: "codex", path: "/opt/codex" },
  ]);
});

test("losing membership stops running tabs in that room", async () => {
  const room = tabRoom(randomUUID(), "running");
  const { coordinator, requests, shared } = sharedSetup(room);
  shared.rooms = [];
  coordinator.changed();
  assert.deepEqual(requests, [
    { type: "tab.stop", roomId: room.id, tabId: room.tabs[0].id },
  ]);
});
