import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryRunStore } from "./store";

const actor = { id: crypto.randomUUID(), name: "Member" };

test("in-memory run store requires an explicit existing thread", async () => {
  const store = createInMemoryRunStore();
  const roomId = crypto.randomUUID();
  const threadA = store.createThread(roomId);
  const threadB = store.createThread(roomId);
  const run = await store.acquireLock(roomId, threadA, actor);
  assert.equal(run.acquired, true);
  if (!run.acquired) return;
  await store.upsertMessage(threadA, {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: "A" }],
  });
  const historyB = await store.loadFrom(roomId, actor, threadB, 0);
  assert.equal(historyB.messages.length, 0);
  await assert.rejects(store.loadFrom(roomId, actor, crypto.randomUUID(), 0));
});

test("inclusive history lookup returns a message revised at the same sequence", async () => {
  const store = createInMemoryRunStore();
  const roomId = crypto.randomUUID();
  const threadId = store.createThread(roomId);
  const messageId = crypto.randomUUID();
  const message = {
    id: messageId,
    role: "assistant" as const,
    parts: [{ type: "text" as const, text: "old" }],
  };
  const firstSeq = await store.upsertMessage(threadId, message);
  await store.upsertMessage(threadId, {
    ...message,
    parts: [{ type: "text", text: "revised" }],
  });
  const result = await store.loadFrom(roomId, actor, threadId, firstSeq);
  assert.equal(result.messages[0]?.seq, firstSeq);
  assert.deepEqual(result.messages[0]?.message.parts, [
    { type: "text", text: "revised" },
  ]);
});
