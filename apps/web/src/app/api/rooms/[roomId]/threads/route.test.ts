import assert from "node:assert/strict";
import test from "node:test";
import { createThreadCollectionHandlers } from "./route";

const roomId = crypto.randomUUID();
const actor = { id: crypto.randomUUID(), name: "Member" };

test("collection auth denial never calls the thread service", async () => {
    let calls = 0;
    const handlers = createThreadCollectionHandlers({
        getActor: async () => null,
        getService: () => {
            calls += 1;
            throw new Error("service must not be created");
        },
    });
    const response = await handlers.GET(
        new Request(`http://localhost/api/rooms/${roomId}/threads`),
        { params: Promise.resolve({ roomId }) },
    );
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
});

test("collection creation preserves the client id and returns 201", async () => {
    const creationId = crypto.randomUUID();
    let received: string | undefined;
    const service = {
        list: async () => ({ threads: [], nextCursor: null }),
        create: async (_roomId: string, _actorId: string, id: string) => {
            received = id;
            return {
                id: crypto.randomUUID(),
                roomId,
                createdAt: new Date().toISOString(),
                retiredAt: null,
                title: "New thread",
                titleSource: "default" as const,
                runStatus: "finished" as const,
                currentRunId: null,
            };
        },
    };
    const handlers = createThreadCollectionHandlers({
        getActor: async () => actor,
        getService: () => service,
    });
    const response = await handlers.POST(
        new Request(`http://localhost/api/rooms/${roomId}/threads`, {
            method: "POST",
            body: JSON.stringify({ creationId }),
        }),
        { params: Promise.resolve({ roomId }) },
    );
    assert.equal(response.status, 201);
    assert.equal(received, creationId);
});
