import type { RunEvent, RunStatus, RunUIMessage } from "@multiplayer-ai/domain";
import { createUIMessageStream, type InferUIMessageChunk } from "ai";
import { createScriptedRunModel } from "./mockModel";
import type { EventSink } from "../run/ports";
import { runTurn } from "../run/run";
import { loadThread } from "../run/loadThread";
import { createInMemoryRunStore } from "../run/store";

const events: Array<RunEvent> = [];
const sink: EventSink = {
  emit(event) {
    events.push(event);
    const { kind, runId: _runId, ...rest } = event;
    console.log(kind.padEnd(19), JSON.stringify(rest).slice(0, 150));
  },
};

const roomId = "room-1";
const actor = { id: crypto.randomUUID(), name: "Demo" };
const store = createInMemoryRunStore();
const lock = await store.acquireLock(roomId, actor);
if (!lock.acquired) throw new Error("expected an idle thread");
const userMessage: RunUIMessage = {
  id: "msg-1",
  role: "user",
  parts: [
    {
      type: "text",
      text: "Recommend a client-side state library for the room UI.",
    },
  ],
  metadata: { author: actor },
};
const seedMessages = [...lock.messages, userMessage];
await store.upsertMessage(lock.threadId, userMessage);

let status: RunStatus = "running";
const stream = createUIMessageStream<RunUIMessage>({
  execute: async ({ writer }) => {
    const runSink: EventSink = {
      ...sink,
      merge: (chunkStream) =>
        writer.merge(
          chunkStream as ReadableStream<InferUIMessageChunk<RunUIMessage>>,
        ),
      setMessageMetadata: (metadata) =>
        writer.write({
          type: "message-metadata",
          messageMetadata: metadata,
        } as InferUIMessageChunk<RunUIMessage>),
    };
    try {
      await runTurn(
        {
          runId: "run-1",
          roomId,
          goal: "Recommend a client-side state library for the room UI.",
          model: "openai:gpt-5-mini",
        },
        seedMessages,
        {
          search: async (query, { maxResults }) =>
            [
              {
                title: "Zustand",
                url: "https://example.com/zustand",
                snippet: `about ${query}`,
              },
            ].slice(0, maxResults),
          sink: runSink,
          modelOverride: createScriptedRunModel(),
        },
      );
      status = "finished";
    } catch {
      status = "failed";
    }
  },
  originalMessages: seedMessages,
  onEnd: async ({ messages }) => {
    for (const message of messages) {
      await store.upsertMessage(lock.threadId, message);
    }
    await store.releaseLock(lock.threadId, status);
  },
});

for await (const _chunk of stream) {
  // Drain the stream so execute() and onEnd() run to completion.
}

const record = await loadThread(store, roomId, actor);
console.log(`\n${events.length} events emitted`);
console.log("persisted messages:", record.messages.length);
