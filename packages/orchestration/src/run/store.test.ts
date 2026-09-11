import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryRunStore } from "./store";

const actor = { id: crypto.randomUUID(), name: "Member" };

test("in-memory run store requires an explicit existing thread", async () => {
    const store = createInMemoryRunStore();
    const roomId = crypto.randomUUID();
    const threadA = store.createThread(roomId);
    const threadB = store.createThread(roomId);
    const run = await store.claimRun(
        roomId,
        threadA,
        actor,
        crypto.randomUUID(),
        {
            id: crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text: "A" }],
        },
    );
    assert.equal(run.outcome, "accepted");
    const historyB = await store.loadFrom(roomId, actor, threadB, 0);
    assert.equal(historyB.messages.length, 0);
    await assert.rejects(store.loadFrom(roomId, actor, crypto.randomUUID(), 0));
});

test("claims isolate threads, accept prompts once and fence late owners", async () => {
    const store = createInMemoryRunStore();
    const room = "room";
    const a = store.createThread(room);
    const b = store.createThread(room);
    const prompt = {
        id: "prompt",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "A" }],
    };
    assert.equal(
        (await store.claimRun(room, a, actor, "X", prompt)).outcome,
        "accepted",
    );
    assert.equal(
        (await store.claimRun(room, a, actor, "retry", prompt)).outcome,
        "already_accepted",
    );
    await assert.rejects(
        store.claimRun(room, a, actor, "busy", { ...prompt, id: "busy" }),
    );
    await assert.rejects(store.claimRun(room, b, actor, "collision", prompt));
    await store.claimRun(room, b, actor, "parallel", { ...prompt, id: "b" });
    assert.equal((await store.loadFrom(room, actor, a, 0)).messages.length, 1);
    await store.finalizeRun(room, a, actor, "X", "finished");
    await store.claimRun(room, a, actor, "Y", { ...prompt, id: "next" });
    await assert.rejects(
        store.writeMessage(room, a, actor, "X", {
            id: "late",
            role: "assistant",
            parts: [],
        }),
    );
    assert.equal(await store.finalizeRun(room, a, actor, "X", "failed"), false);
    assert.equal((await store.loadFrom(room, actor, a, 0)).status, "running");
    assert.equal((await store.loadFrom(room, actor, b, 0)).status, "running");
});

test("inclusive history lookup returns a message revised at the same sequence", async () => {
    const store = createInMemoryRunStore();
    const roomId = crypto.randomUUID();
    const threadId = store.createThread(roomId);
    const messageId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await store.claimRun(roomId, threadId, actor, runId, {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "prompt" }],
    });
    const message = {
        id: messageId,
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: "old" }],
    };
    const firstSeq = await store.writeMessage(
        roomId,
        threadId,
        actor,
        runId,
        message,
    );
    await store.writeMessage(roomId, threadId, actor, runId, {
        ...message,
        parts: [{ type: "text", text: "revised" }],
    });
    const result = await store.loadFrom(roomId, actor, threadId, firstSeq);
    assert.equal(result.messages[0]?.seq, firstSeq);
    assert.deepEqual(result.messages[0]?.message.parts, [
        { type: "text", text: "revised" },
    ]);
});
