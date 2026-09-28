import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { Journal } from "./journal";
import { withHost } from "./test-support";

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
