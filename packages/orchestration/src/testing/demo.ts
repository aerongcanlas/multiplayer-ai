import type { RunEvent, RunStatus, RunUIMessage } from "@multiplayer-ai/domain";
import { createUIMessageStream, type InferUIMessageChunk } from "ai";
import { createScriptedRunModel } from "./mockModel";
import type { EventSink } from "../run/ports";
import { runTurn } from "../run/run";
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
const store = createInMemoryRunStore();
const thread = await store.load(roomId);
const userMessage: RunUIMessage = {
  id: "msg-1",
  role: "user",
  parts: [
    {
      type: "text",
      text: "Recommend a client-side state library for the room UI.",
    },
  ],
};
const seedMessages = [...thread.messages, userMessage];
await store.save(roomId, { messages: seedMessages, status: "running" });

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
    await store.save(roomId, { messages, status });
  },
});

for await (const _chunk of stream) {
  // Drain the stream so execute() and onEnd() run to completion.
}

const record = await store.load(roomId);
console.log(`\n${events.length} events emitted`);
console.log("persisted messages:", record.messages.length);
