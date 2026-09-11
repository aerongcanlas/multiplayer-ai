import assert from "node:assert/strict";
import test from "node:test";
import { startRunRequestSchema } from "@multiplayer-ai/domain";
import { runStoreFailure, withActor } from "./route";

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
