import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadSummary } from "@multiplayer-ai/domain";
import type { ThreadStore } from "./threadStore";
import { createThreadService, ThreadServiceError } from "./threadService";

const roomId = crypto.randomUUID();
const threadId = crypto.randomUUID();
const summary: ThreadSummary = {
    id: threadId,
    roomId,
    createdAt: "2026-09-11T04:00:00.000Z",
    retiredAt: null,
    title: "New thread",
    titleSource: "default",
    runStatus: "finished",
    currentRunId: null,
};

function fakeStore(overrides: Partial<ThreadStore> = {}): ThreadStore {
    return {
        list: async () => [summary],
        listPage: async () => ({ threads: [summary], nextCursor: null }),
        get: async () => ({ ...summary, messages: [] }),
        create: async () => summary,
        claimRun: async () => {
            throw new Error("unused");
        },
        writeMessage: async () => ({
            messageId: crypto.randomUUID(),
            seq: 1,
            outcome: "inserted",
        }),
        finalizeRun: async () => ({ outcome: "finalized", status: "finished" }),
        archive: async () => ({
            outcome: "archived",
            threadId,
            retiredAt: new Date().toISOString(),
        }),
        restore: async () => ({ outcome: "restored", threadId, retiredAt: "" }),
        rename: async () => ({
            threadId,
            title: "Renamed",
            titleSource: "manual",
        }),
        ...overrides,
    };
}

test("creation retries are delegated with the same client creation id", async () => {
    const ids: string[] = [];
    const service = createThreadService(
        fakeStore({
            create: async (_room, _actor, creationId) => {
                if (creationId !== undefined) ids.push(creationId);
                return summary;
            },
        }),
    );
    const creationId = crypto.randomUUID();
    await service.create(roomId, crypto.randomUUID(), creationId);
    await service.create(roomId, crypto.randomUUID(), creationId);
    assert.deepEqual(ids, [creationId, creationId]);
});

test("membership and room/thread mismatches become uniform no-data errors", async () => {
    const service = createThreadService(
        fakeStore({
            get: async () => {
                throw Object.assign(new Error("not found"), { code: "P0002" });
            },
        }),
    );
    await assert.rejects(
        service.get(roomId, threadId, crypto.randomUUID()),
        (error: unknown) =>
            error instanceof ThreadServiceError &&
            error.status === 404 &&
            error.code === "not_found",
    );
});

test("archive conflicts are typed busy responses", async () => {
    const service = createThreadService(
        fakeStore({
            archive: async () => {
                throw Object.assign(new Error("busy"), { code: "55P03" });
            },
        }),
    );
    await assert.rejects(
        service.update(roomId, threadId, crypto.randomUUID(), {
            action: "archive",
        }),
        (error: unknown) =>
            error instanceof ThreadServiceError &&
            error.status === 409 &&
            error.code === "busy",
    );
});

test("history reads are inclusive and do not create or switch threads", async () => {
    const service = createThreadService(
        fakeStore({
            get: async () => ({
                ...summary,
                messages: [
                    {
                        id: crypto.randomUUID(),
                        seq: 3,
                        threadId,
                        role: "assistant",
                        parts: [{ type: "text", text: "revised" }],
                        metadata: undefined,
                        authorId: null,
                        createdAt: summary.createdAt,
                        runId: null,
                    },
                ],
            }),
        }),
    );
    const history = await service.history(roomId, threadId, actorId(), 3);
    assert.equal(history.messages.length, 1);
    assert.equal(history.messages[0]?.seq, 3);
});

function actorId(): string {
    return crypto.randomUUID();
}
