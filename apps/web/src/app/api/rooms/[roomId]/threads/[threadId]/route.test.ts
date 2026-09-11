import assert from "node:assert/strict";
import test from "node:test";
import { ThreadServiceError } from "@/features/threads/server/threadService";
import { createThreadDetailHandlers } from "./route";

const roomId = crypto.randomUUID();
const threadId = crypto.randomUUID();
const actor = { id: crypto.randomUUID(), name: "Member" };
const context = { params: Promise.resolve({ roomId, threadId }) };

test("detail returns a uniform no-data 404 for inaccessible identities", async () => {
    const service = {
        get: async () => {
            throw new ThreadServiceError("not_found", "Thread not found", 404);
        },
        update: async () => {
            throw new Error("unused");
        },
    };
    const handlers = createThreadDetailHandlers({
        getActor: async () => actor,
        getService: () => service,
    });
    const response = await handlers.GET(
        new Request(`http://localhost/api/rooms/${roomId}/threads/${threadId}`),
        context,
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
        error: "Thread not found",
        code: "not_found",
    });
});

test("detail exposes typed archive conflicts", async () => {
    const service = {
        get: async () => {
            throw new Error("unused");
        },
        update: async () => {
            throw new ThreadServiceError(
                "busy",
                "Thread has an active run",
                409,
            );
        },
    };
    const handlers = createThreadDetailHandlers({
        getActor: async () => actor,
        getService: () => service,
    });
    const response = await handlers.PATCH(
        new Request(
            `http://localhost/api/rooms/${roomId}/threads/${threadId}`,
            {
                method: "PATCH",
                body: JSON.stringify({ action: "archive" }),
            },
        ),
        context,
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
        error: "Thread has an active run",
        code: "busy",
    });
});
