import type { RunEvent } from "@multiplayer-ai/domain";
import { createScriptedRunModel } from "./mockModel";
import type { EventSink } from "../run/ports";
import { startRun } from "../run/run";
import { createInMemoryRunStore } from "../run/store";

const events: Array<RunEvent> = [];
const sink: EventSink = {
    emit(event) {
        events.push(event);
        const { kind, runId, ...rest } = event;
        console.log(kind.padEnd(19), JSON.stringify(rest).slice(0, 150));
    },
};

const store = createInMemoryRunStore();
await startRun(
    {
        runId: "run-1",
        roomId: "room-1",
        goal: "Recommend a client-side state library for the room UI.",
        model: "openai:gpt-5-mini",
    },
    {
        search: async (query, { maxResults }) =>
            [
                {
                    title: "Zustand",
                    url: "https://example.com/zustand",
                    snippet: `about ${query}`,
                },
            ].slice(0, maxResults),
        sink,
        store,
        modelOverride: createScriptedRunModel(),
    },
);

const record = await store.load("run-1");
console.log(`\n${events.length} events emitted`);
console.log("persisted messages:", record?.messages.length);
