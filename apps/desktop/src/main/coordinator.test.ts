import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { signedOutState } from "../shared/collaboration";
import type { Room, Snapshot, SupervisorRequest } from "../shared/contracts";
import type { Tab } from "../shared/tabs";
import { DesktopCoordinator } from "./coordinator";

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
                readAlongWindows: [],
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
        command: (async () => undefined) as (command: {
            type: string;
        }) => Promise<undefined>,
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

test("shared suggestions persist generated text and reject duplicate or switched-account requests", async () => {
    const userId = randomUUID();
    const room = tabRoom(userId);
    const local: Snapshot = {
        protocolVersion: 2,
        sync: "local-only",
        revision: 1,
        hostId: randomUUID(),
        rooms: [room],
    };
    const saved: string[][] = [];
    let finish!: () => void;
    let generationStarted!: () => void;
    let started = new Promise<void>((resolve) => {
        generationStarted = resolve;
    });
    const shared = {
        rooms: [structuredClone(room)],
        state: {
            ...signedOutState(),
            status: "connected" as const,
            account: { id: userId, name: "Alice" },
        },
        command: async (_command: unknown, prompts?: string[]) => {
            saved.push(prompts!);
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
                    generationStarted();
                    await new Promise<void>((resolve) => {
                        finish = resolve;
                    });
                    room.suggestions.push({
                        id: randomUUID(),
                        prompt: "Generated direction",
                        contextVersion: 0,
                        sourceMessageIds: [],
                        sources: [],
                        revision: 1,
                        status: "draft",
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    });
                    local.revision++;
                }
                return { ok: true, snapshot: structuredClone(local) };
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
    const first = coordinator.dispatch(command);
    await started;
    assert.deepEqual(await coordinator.dispatch(command), {
        ok: false,
        error: "Prompt generation is already in progress.",
    });
    finish();
    assert.equal((await first).ok, true);
    assert.deepEqual(saved, [["Generated direction"]]);
    started = new Promise<void>((resolve) => {
        generationStarted = resolve;
    });
    const switched = coordinator.dispatch(command);
    await started;
    shared.state.account.id = randomUUID();
    finish();
    assert.equal((await switched).ok, false);
    assert.equal(saved.length, 1);
});

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

test("read-along turns on only after a membership check and turns off while offline", async () => {
    let online = true;
    const room = tabRoom(randomUUID());
    const tabId = room.tabs[0].id;
    const { coordinator, requests, shared } = sharedSetup(room, async () => {
        if (!online) throw new Error("offline");
    });
    const toggle = (on: boolean) =>
        coordinator.dispatch({
            type: "tab.setReadAlong",
            roomId: room.id,
            tabId,
            on,
        });
    assert.equal((await toggle(true)).ok, true);
    assert.deepEqual(
        requests.map((request) => request.type),
        ["shared.import", "tab.setReadAlong"],
    );
    // Other hosts' read-along rows never reach the journal.
    const imported = requests[0] as Extract<
        SupervisorRequest["command"],
        { type: "shared.import" }
    >;
    assert.equal(imported.room.shared?.sharedTabs, undefined);
    requests.length = 0;
    online = false;
    (shared.state as { status: string }).status = "offline";
    assert.equal((await toggle(true)).ok, false);
    assert.equal((await toggle(false)).ok, true);
    assert.deepEqual(
        requests.map((request) => request.type),
        ["tab.setReadAlong"],
    );
    shared.rooms = [];
    online = true;
    assert.equal((await toggle(true)).ok, false);
    const local = tabRoom(randomUUID());
    delete local.shared;
    const { coordinator: localOnly, requests: localRequests } =
        sharedSetup(local);
    const refused = await localOnly.dispatch({
        type: "tab.setReadAlong",
        roomId: local.id,
        tabId: local.tabs[0].id,
        on: true,
    });
    assert.deepEqual(refused, {
        ok: false,
        error: "Read-along needs a shared room.",
    });
    assert.deepEqual(localRequests, []);
});

test("own-device rows are hidden and this account's other desktops are labelled", () => {
    const userId = randomUUID();
    const room = tabRoom(userId);
    const { coordinator, shared } = sharedSetup(room);
    const hostId = coordinator.snapshot()!.hostId;
    const row = (hostIdValue: string, deviceId: string) => ({
        tabId: randomUUID(),
        roomId: room.id,
        hostId: hostIdValue,
        hostName: "Name",
        deviceId,
        title: "Tab",
        harness: "codex" as const,
        model: "m",
        status: "running" as const,
        switchOn: true,
        rev: 1,
        updatedAt: "now",
    });
    const own = row(userId, hostId);
    const otherDevice = row(userId, "second-desktop");
    const spoofed = row(randomUUID(), hostId);
    shared.state = {
        ...shared.state,
        auth: "signed_in",
        account: { id: userId, name: "Me" },
    } as never;
    shared.rooms = [
        {
            ...shared.rooms[0],
            shared: {
                ...shared.rooms[0].shared!,
                sharedTabs: [own, otherDevice, spoofed],
            },
        },
    ];
    coordinator.changed();
    const listed = coordinator.snapshot()!.rooms[0].shared!.sharedTabs!;
    assert.deepEqual(
        listed.map((tab) => [tab.tabId, tab.sameUser ?? false]),
        [
            [otherDevice.tabId, true],
            [spoofed.tabId, false],
        ],
    );
});

test("leaving a shared room asks the server first, then removes this desktop's copy", async () => {
    const room = tabRoom(randomUUID());
    const { coordinator, requests, shared } = sharedSetup(room);
    const sent: string[] = [];
    shared.command = async (command: { type: string }) => {
        sent.push(command.type);
        shared.rooms = [];
        return undefined;
    };
    const left = await coordinator.dispatch({
        type: "room.leave",
        roomId: room.id,
    });
    assert.equal(left.ok, true);
    assert.deepEqual(sent, ["room.leave"]);
    assert.deepEqual(requests, [{ type: "room.delete", roomId: room.id }]);
});

test("a room with a running chat is never deleted or left, and local rooms cannot be left", async () => {
    const running = tabRoom(randomUUID(), "running");
    const { coordinator, requests, shared } = sharedSetup(running);
    const sent: string[] = [];
    shared.command = async (command: { type: string }) => {
        sent.push(command.type);
        return undefined;
    };
    for (const type of ["room.delete", "room.leave"] as const) {
        const result = await coordinator.dispatch({ type, roomId: running.id });
        assert.equal(result.ok, false);
        assert.match(result.ok ? "" : result.error, /running chats/);
    }
    assert.deepEqual(sent, []);
    assert.deepEqual(requests, []);

    const local = { ...tabRoom(randomUUID()), shared: undefined, tabs: [] };
    const setup = sharedSetup(local);
    const refused = await setup.coordinator.dispatch({
        type: "room.leave",
        roomId: local.id,
    });
    assert.equal(refused.ok, false);
    assert.deepEqual(setup.requests, []);
});
