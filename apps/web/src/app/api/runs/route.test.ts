import assert from "node:assert/strict";
import test from "node:test";
import { startRunRequestSchema } from "@multiplayer-ai/domain";
import { runStoreFailure, startRun, withActor } from "./route";
import { createInMemoryRunStore } from "@multiplayer-ai/orchestration";
import { runRuntime } from "@/features/runs/server/runRuntime";

test("legacy room-only run requests fail closed", () => {
    assert.equal(
        startRunRequestSchema.safeParse({
            roomId: crypto.randomUUID(),
            prompt: "Legacy request",
            model: "openai:gpt-5-mini",
        }).success,
        false,
    );
});

test("replay failure after claim finalizes the owned token failed", async (t) => {
    const store = createInMemoryRunStore();
    const roomId = crypto.randomUUID();
    const threadId = store.createThread(roomId);
    const actor = { id: crypto.randomUUID(), name: "Actor" };
    const load = store.loadFrom;
    t.mock.method(store, "loadFrom", async () => {
        throw new Error("replay unavailable");
    });
    t.mock.method(runRuntime, "store", () => store);
    t.mock.method(runRuntime, "broadcaster", () => ({
        send: async () => {},
        close: async () => {},
    }));
    t.mock.method(console, "error", () => {});
    const response = await startRun(
        new Request("http://localhost/api/runs", {
            method: "POST",
            body: JSON.stringify({
                roomId,
                threadId,
                userMessageId: crypto.randomUUID(),
                prompt: "hello",
                model: "openai:gpt-5-mini",
            }),
        }),
        actor,
    );
    assert.equal(response.status, 500);
    assert.equal((await load(roomId, actor, threadId, 0)).status, "failed");
});

test("accepted prompt retry launches no provider and remains once in selected replay", async (t) => {
    const store = createInMemoryRunStore();
    const roomId = crypto.randomUUID();
    const threadId = store.createThread(roomId);
    const actor = { id: crypto.randomUUID(), name: "Actor" };
    const userMessageId = crypto.randomUUID();
    await store.claimRun(roomId, threadId, actor, crypto.randomUUID(), {
        id: userMessageId,
        role: "user",
        parts: [{ type: "text", text: "hello" }],
    });
    t.mock.method(runRuntime, "store", () => store);
    const provider = t.mock.method(runRuntime, "modelOverride", () => {
        throw new Error("must not launch");
    });
    const response = await startRun(
        new Request("http://localhost/api/runs", {
            method: "POST",
            body: JSON.stringify({
                roomId,
                threadId,
                userMessageId,
                prompt: "hello",
                model: "openai:gpt-5-mini",
            }),
        }),
        actor,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).outcome, "already_accepted");
    assert.equal(provider.mock.callCount(), 0);
    assert.equal(
        (await store.loadFrom(roomId, actor, threadId, 0)).messages.length,
        1,
    );
});

test("unauthorized run requests never invoke execution", async () => {
    let executions = 0;
    const handler = withActor(
        async () => {
            executions += 1;
            return new Response(null, { status: 204 });
        },
        async () => null,
    );
    const response = await handler(new Request("http://localhost/api/runs"));
    assert.equal(response.status, 401);
    assert.equal(executions, 0);
});

test("run-store identity and archive failures use public no-data/conflict contracts", async () => {
    const missing = runStoreFailure(
        Object.assign(new Error("membership denied"), { code: "42501" }),
    );
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {
        error: "Thread not found",
        code: "not_found",
    });

    const archived = runStoreFailure(
        Object.assign(new Error("archived"), { code: "P0001" }),
    );
    assert.equal(archived.status, 409);
    assert.deepEqual(await archived.json(), {
        error: "Thread is archived",
        code: "archived",
    });
});
