import type { RunEvent, RunUIMessage } from "@multiplayer-ai/domain";
import { APICallError } from "@ai-sdk/provider";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createUIMessageStream, simulateReadableStream, type InferUIMessageChunk } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { runTurn } from "../run/run";
import type { EventSink } from "../run/ports";

function contextLengthError(): APICallError {
    return new APICallError({
        message:
            "This model's maximum context length is 400000 tokens. However, your messages resulted in more tokens than that.",
        url: "https://example.com",
        requestBodyValues: {},
        statusCode: 400,
        isRetryable: false,
    });
}

function okStream(): ReadableStream<LanguageModelV4StreamPart> {
    return simulateReadableStream({
        chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Paris." },
            { type: "text-end", id: "t1" },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                    inputTokens: { total: 300, noCache: 300, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 10, text: 10, reasoning: 0 },
                },
            },
        ],
        initialDelayInMs: 0,
        chunkDelayInMs: 0,
    });
}

async function run(scenario: "recovers" | "exhausts") {
    console.log(`\n=== scenario: ${scenario} ===`);
    let calls = 0;
    const model = new MockLanguageModelV4({
        doStream: async () => {
            calls++;
            if (scenario === "exhausts" || calls === 1) throw contextLengthError();
            return { stream: okStream() };
        },
    });

    const events: Array<RunEvent> = [];
    const userMessage: RunUIMessage = {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "What is the capital of France?" }],
    };

    const stream = createUIMessageStream<RunUIMessage>({
        execute: async ({ writer }) => {
            const sink: EventSink = {
                emit(event) {
                    events.push(event);
                },
                merge: (s) =>
                    writer.merge(s as ReadableStream<InferUIMessageChunk<RunUIMessage>>),
                setMessageMetadata: (metadata) =>
                    writer.write({
                        type: "message-metadata",
                        messageMetadata: metadata,
                    } as InferUIMessageChunk<RunUIMessage>),
            };
            try {
                await runTurn(
                    {
                        runId: "verify-1",
                        roomId: "verify-room",
                        goal: "What is the capital of France?",
                        model: "openai:gpt-5-mini",
                        effort: "low",
                    },
                    [userMessage],
                    { search: async () => [], sink, modelOverride: model },
                );
            } catch {
                // expected in the "exhausts" scenario
            }
        },
        originalMessages: [userMessage],
    });

    for await (const _chunk of stream) {
        // drain
    }

    console.log("doStream call count:", calls);
    console.log("event kinds:", events.map((e) => e.kind).join(", "));
    const compacted = events.some((e) => e.kind === "run.compacted");
    const finished = events.some((e) => e.kind === "run.finished");
    const failed = events.some((e) => e.kind === "run.failed");
    console.log({ compacted, finished, failed });

    if (scenario === "recovers") {
        if (calls !== 2) throw new Error(`expected exactly 2 calls, got ${calls}`);
        if (!compacted) throw new Error("expected run.compacted to fire on retry");
        if (!finished) throw new Error("expected run.finished after successful retry");
        if (failed) throw new Error("did not expect run.failed");
    } else {
        if (calls !== 2) throw new Error(`expected exactly 2 calls (no third attempt), got ${calls}`);
        if (!failed) throw new Error("expected run.failed after retry also overflows");
    }
    console.log(`PASS: ${scenario}`);
}

await run("recovers");
await run("exhausts");
console.log("\nAll overflow-retry scenarios passed.");
