import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { harnessAdapters } from "./adapters";
import { Journal } from "./journal";
import { FakeHarness } from "./harnesses/fake";
import { OpenCodeAdapter } from "./harnesses/opencode/adapter";
import { start, withHost } from "./test-support";

test("a suggestion used in a tab is submitted in a local room and stays draft in a shared room", () =>
    withHost(async ({ service, roomId, journal, settled }, fake) => {
        await service.dispatch({
            type: "message.send",
            roomId,
            text: "Shared feedback",
        });
        const original = service.snapshot().rooms[0];
        await service.dispatch({
            type: "suggestion.create",
            roomId,
            messageIds: [original.messages[0].id],
        });
        // The shared copy carries the suggestion as the room's canonical draft.
        const drafted = structuredClone(service.snapshot().rooms[0]);
        await service.dispatch({ type: "tab.open", roomId, harness: "codex" });
        const local = service.snapshot().rooms[0];
        await service.dispatch({
            type: "tab.send",
            roomId,
            tabId: local.tabs[0].id,
            text: local.suggestions[0].prompt,
            suggestionId: local.suggestions[0].id,
            suggestionRevision: 1,
        });
        await settled(local.tabs[0].id);
        assert.equal(
            service.snapshot().rooms[0].suggestions[0].status,
            "submitted",
        );

        // A shared room imports canonical chat and suggestions; its tabs stay on this desktop.
        const shared = {
            ...drafted,
            id: randomUUID(),
            workspace: null,
            tabs: [],
            shared: {
                userId: randomUUID(),
                project: "test",
                isAdmin: true,
                members: [],
            },
        };
        await service.dispatch({ type: "shared.import", room: shared });
        await service.dispatch({
            type: "workspace.register",
            roomId: shared.id,
            workspace: journal.getWorkspace(local.workspace!.id)!,
        });
        await service.dispatch({
            type: "tab.open",
            roomId: shared.id,
            harness: "codex",
        });
        const room = () => service.snapshot().rooms[1];
        const tabId = room().tabs[0].id;
        await service.dispatch({
            type: "tab.send",
            roomId: shared.id,
            tabId,
            text: "Use room feedback",
            suggestionId: shared.suggestions[0].id,
            suggestionRevision: 1,
        });
        await settled(tabId, shared.id);
        assert.equal(room().suggestions[0].status, "draft");
        await service.dispatch({ type: "shared.import", room: shared });
        assert.equal(room().tabs[0].id, tabId);
        assert.ok(room().workspace);
        assert.equal(
            fake.calls.filter((call) => call.startsWith("send:")).length,
            2,
        );
    }));

test("messages and editable attributed suggestions persist; generating a suggestion does not dispatch work", () =>
    withHost(async ({ service, roomId, dir }, fake) => {
        await service.dispatch({
            type: "message.send",
            roomId,
            text: "Keep the existing component architecture.",
        });
        const message = service.snapshot().rooms[0].messages[0];
        await service.dispatch({
            type: "suggestion.create",
            roomId,
            messageIds: [message.id],
        });
        const suggestion = service.snapshot().rooms[0].suggestions[0];
        assert.equal(
            suggestion.prompt,
            "Review the selected feedback and propose the next concrete change.",
        );
        assert.ok(fake.calls.includes("suggest"));
        assert.deepEqual(service.snapshot().rooms[0].tabs, []);
        assert.equal(
            fake.calls.some((call) => call.startsWith("send:")),
            false,
        );
        assert.equal(suggestion.sources[0].text, message.text);
        assert.equal(suggestion.contextVersion, 0);
        await service.dispatch({
            type: "suggestion.edit",
            roomId,
            suggestionId: suggestion.id,
            prompt: "Review first.",
            expectedRevision: 1,
        });
        await assert.rejects(
            service.dispatch({
                type: "suggestion.edit",
                roomId,
                suggestionId: suggestion.id,
                prompt: "Overwrite.",
                expectedRevision: 1,
            }),
            /changed/,
        );
        const persisted = new Journal(join(dir, "journal.sqlite"));
        assert.equal(
            persisted.load().rooms[0].suggestions[0].prompt,
            "Review first.",
        );
        assert.equal(
            persisted.load().rooms[0].suggestions[0].sources[0].id,
            message.id,
        );
        persisted.close();
    }));

test("cross-room and unknown messages are rejected without mutating state", () =>
    withHost(async ({ service, roomId }) => {
        await service.dispatch({ type: "room.create", name: "Another room" });
        const other = service.snapshot().rooms[1];
        await service.dispatch({
            type: "message.send",
            roomId: other.id,
            text: "Private to this room.",
        });
        const revision = service.snapshot().revision;
        await assert.rejects(
            service.dispatch({
                type: "suggestion.create",
                roomId,
                messageIds: [service.snapshot().rooms[1].messages[0].id],
            }),
            /does not belong/,
        );
        await assert.rejects(
            service.dispatch({
                type: "suggestion.create",
                roomId,
                messageIds: [randomUUID()],
            }),
            /does not belong/,
        );
        assert.equal(service.snapshot().revision, revision);
    }));

test("signed-out or failed generation preserves messages without saving a fallback", () =>
    withHost(async ({ service, roomId }, fake) => {
        await service.dispatch({
            type: "message.send",
            roomId,
            text: "Selected feedback",
        });
        const command = {
            type: "suggestion.create" as const,
            roomId,
            messageIds: [service.snapshot().rooms[0].messages[0].id],
        };
        fake.signedIn = false;
        await assert.rejects(service.dispatch(command), /Sign in with ChatGPT/);
        fake.signedIn = true;
        fake.suggest = async () => {
            throw new Error("Generation failed");
        };
        await assert.rejects(service.dispatch(command), /Generation failed/);
        const room = service.snapshot().rooms[0];
        assert.equal(room.messages.length, 1);
        assert.deepEqual(room.suggestions, []);
        assert.deepEqual(room.tabs, []);
    }));

test("the repository cannot change under a running tab", () =>
    withHost(async ({ service, roomId, journal, settled, stopTab }) => {
        await service.dispatch({ type: "tab.open", roomId, harness: "codex" });
        const room = service.snapshot().rooms[0];
        await service.dispatch({
            type: "tab.send",
            roomId,
            tabId: room.tabs[0].id,
            text: "FAKE_SLOW",
        });
        await assert.rejects(
            service.dispatch({
                type: "workspace.register",
                roomId,
                workspace: journal.getWorkspace(room.workspace!.id)!,
            }),
            /Stop running tabs/,
        );
        await stopTab(room.tabs[0].id);
        await settled(room.tabs[0].id);
    }));

test("deleting a room purges its chats and waits for running ones to stop", () =>
    withHost(async ({ service, roomId, journal, settled, stopTab }) => {
        await service.dispatch({ type: "tab.open", roomId, harness: "codex" });
        const tabId = service.snapshot().rooms[0].tabs[0].id;
        await service.dispatch({
            type: "tab.send",
            roomId,
            tabId,
            text: "FAKE_SLOW",
        });
        await assert.rejects(
            service.dispatch({ type: "room.delete", roomId }),
            /Stop this room's running chats/,
        );
        await stopTab(tabId);
        await settled(tabId);
        assert.ok(journal.transcriptPage(tabId).entries.length > 0);
        await assert.rejects(
            service.dispatch({ type: "room.leave", roomId }),
            /main-process connection/,
        );
        await service.dispatch({ type: "room.delete", roomId });
        assert.equal(
            service.snapshot().rooms.some((room) => room.id === roomId),
            false,
        );
        assert.deepEqual(journal.transcriptPage(tabId).entries, []);
        assert.equal(
            journal.load().rooms.some((room) => room.id === roomId),
            false,
        );
    }));

const opencodeFixture = fileURLToPath(
    new URL("../../scripts/opencode-fixture.mjs", import.meta.url),
);
const fixtureLauncher =
    (log: string) =>
    (_executable: string, args: string[], env: Record<string, string>) => ({
        executable: process.execPath,
        args: [opencodeFixture, ...args],
        env: { ...env, MP_OPENCODE_FIXTURE_LOG: log },
    });

test("the service lists all three harnesses and runs an OpenCode tab on its fixture", async () => {
    const logs = await mkdtemp(join(tmpdir(), "multiplayer-opencode-service-"));
    const opencode = new OpenCodeAdapter({
        launcher: fixtureLauncher(join(logs, "opencode.log")),
        discover: async () => ({
            servers: [],
            providers: [
                {
                    id: "ollama",
                    name: "Ollama",
                    baseURL: "http://127.0.0.1:11434/v1",
                    models: [{ id: "qwen3-coder:30b", name: "qwen3-coder:30b" }],
                },
            ],
        }),
    });
    const setup = await start(new FakeHarness("codex"), undefined, [
        new FakeHarness("claude", { signIn: "guidance" }),
        opencode,
    ]);
    try {
        assert.deepEqual(
            setup.service.snapshot().harnesses!.map((state) => state.id),
            ["codex", "claude", "opencode"],
        );
        await setup.registry.refresh("opencode");
        assert.equal(setup.registry.state("opencode").auth.state, "signed_in");
        await setup.dispatch({
            type: "tab.open",
            roomId: setup.roomId,
            harness: "opencode",
        });
        const tab = setup.tabs().at(-1)!;
        assert.equal(tab.loadout.harness, "opencode");
        assert.equal(tab.loadout.model, "ollama/qwen3-coder:30b");
        await setup.send(tab.id, "Say hello");
        await setup.settled(tab.id);
        const entries = await setup.transcript(tab.id);
        assert.ok(
            entries.some(
                (entry) =>
                    entry.kind === "assistant" &&
                    entry.summary === "Hello world.",
            ),
        );
        assert.equal(setup.tab(tab.id).status, "idle");
        assert.ok(setup.tab(tab.id).sessionId?.startsWith("ses_fixture_"));
    } finally {
        setup.close();
    }
});

test("fixtures are chosen by name, so leaving out OpenCode's shifts no other harness", async () => {
    const codexFixture = fileURLToPath(
        new URL("../../scripts/codex-fixture.mjs", import.meta.url),
    );
    const adapters = await harnessAdapters({ codexFixture });
    try {
        assert.deepEqual(
            adapters.map((adapter) => adapter.id),
            ["codex", "claude", "opencode"],
        );
        const context = {
            executable: "/nonexistent/harness",
            env: {
                PATH: process.env.PATH ?? "",
                CODEX_HOME: "/nonexistent/home",
            },
            home: "/nonexistent/home",
            hostPaths: {},
        };
        // Codex answers from its fixture; OpenCode tries the real (missing) program.
        assert.ok((await adapters[0]!.handshake(context)).version);
        await assert.rejects(adapters[2]!.handshake(context));
    } finally {
        for (const adapter of adapters) adapter.close();
    }
});

test("with no usable model an OpenCode tab cannot start a turn (AE3)", async () => {
    const logs = await mkdtemp(join(tmpdir(), "multiplayer-opencode-service-"));
    const setup = await start(new FakeHarness("codex"), undefined, [
        new OpenCodeAdapter({
            launcher: fixtureLauncher(join(logs, "opencode.log")),
            discover: async () => ({ servers: [], providers: [] }),
        }),
    ]);
    try {
        await setup.registry.refresh("opencode");
        const state = setup.registry.state("opencode");
        assert.equal(state.auth.state, "signed_out");
        assert.match(state.auth.message ?? "", /No models available/);
        await setup.dispatch({
            type: "tab.open",
            roomId: setup.roomId,
            harness: "opencode",
        });
        const tab = setup.tabs().at(-1)!;
        assert.equal(tab.status, "unavailable");
        await assert.rejects(setup.send(tab.id, "Hello"));
    } finally {
        setup.close();
    }
});
