import { ScoutBrief, Verdict } from "@multiplayer-ai/domain";
import type {
    LanguageModelV4FinishReason,
    LanguageModelV4GenerateResult,
    LanguageModelV4StreamPart,
    LanguageModelV4ToolCall,
    LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

const STOP: LanguageModelV4FinishReason = { unified: "stop", raw: "stop" };
const TOOL_CALLS: LanguageModelV4FinishReason = {
    unified: "tool-calls",
    raw: "tool_calls",
};

function usage(outputTokens: number): LanguageModelV4Usage {
    return {
        inputTokens: { total: 500, noCache: 500, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
    };
}

function toolCallPart(
    toolCallId: string,
    toolName: string,
    input: unknown,
): LanguageModelV4ToolCall {
    return {
        type: "tool-call",
        toolCallId,
        toolName,
        input: JSON.stringify(input),
    };
}

function streamStep(step: {
    reasoning?: string;
    text?: string;
    toolCall?: { id: string; name: string; input: unknown };
}): ReadableStream<LanguageModelV4StreamPart> {
    const chunks: Array<LanguageModelV4StreamPart> = [
        { type: "stream-start", warnings: [] },
    ];

    if (step.reasoning) {
        chunks.push(
            { type: "reasoning-start", id: "reasoning-1" },
            { type: "reasoning-delta", id: "reasoning-1", delta: step.reasoning },
            { type: "reasoning-end", id: "reasoning-1" },
        );
    }

    if (step.text) {
        chunks.push(
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: step.text },
            { type: "text-end", id: "text-1" },
        );
    }

    if (step.toolCall) {
        const input = JSON.stringify(step.toolCall.input);
        chunks.push(
            {
                type: "tool-input-start",
                id: step.toolCall.id,
                toolName: step.toolCall.name,
            },
            { type: "tool-input-delta", id: step.toolCall.id, delta: input },
            { type: "tool-input-end", id: step.toolCall.id },
            toolCallPart(step.toolCall.id, step.toolCall.name, step.toolCall.input),
        );
    }

    chunks.push({
        type: "finish",
        finishReason: step.toolCall ? TOOL_CALLS : STOP,
        usage: usage(80),
    });

    return simulateReadableStream({
        chunks,
        initialDelayInMs: 120,
        chunkDelayInMs: 60,
    });
}

const SCOUT_BRIEF: ScoutBrief = {
    summary:
        "Zustand is the best fit for room-local client state: minimal API, no context " +
        "provider tree, and it plays well with React 19 + Next 16.",
    findings: [
        {
            claim: "Zustand has no required provider wrapper.",
            source: "https://zustand.docs.pmnd.rs/",
        },
        {
            claim: "Redux Toolkit is heavier than this scope needs.",
            source: "https://redux-toolkit.js.org/",
        },
    ],
    confidence: "medium",
    gaps: [
        "Did not benchmark re-render performance under heavy multiplayer updates.",
    ],
};

const VERDICT: Verdict = { ok: true, issues: [] };

export function createScriptedRunModel(): MockLanguageModelV4 {
    const streamSteps: Array<() => ReadableStream<LanguageModelV4StreamPart>> = [
        () =>
            streamStep({
                reasoning: "Wide reading — delegating to @scout.",
                toolCall: {
                    id: "call_delegate",
                    name: "delegate",
                    input: {
                        task: "Which client-side state library fits this room UI best?",
                    },
                },
            }),
        () =>
            streamStep({
                text: "Zustand is the recommended client-side state library for the room UI.",
            }),
    ];

    const generateSteps: Array<() => LanguageModelV4GenerateResult> = [
        () => ({
            content: [
                toolCallPart("call_search", "webSearch", {
                    query: "zustand vs redux toolkit 2026",
                }),
            ],
            finishReason: TOOL_CALLS,
            usage: usage(40),
            warnings: [],
        }),
        () => ({
            content: [{ type: "text", text: JSON.stringify(SCOUT_BRIEF) }],
            finishReason: STOP,
            usage: usage(180),
            warnings: [],
        }),
        () => ({
            content: [{ type: "text", text: JSON.stringify(VERDICT) }],
            finishReason: STOP,
            usage: usage(20),
            warnings: [],
        }),
    ];

    let streamIndex = 0;
    let generateIndex = 0;

    return new MockLanguageModelV4({
        doStream: async () => {
            const next = streamSteps[streamIndex++];
            if (!next) {
                throw new Error("Mock script exhausted: doStream ran longer than scripted.");
            }
            return { stream: next() };
        },
        doGenerate: async () => {
            const next = generateSteps[generateIndex++];
            if (!next) {
                throw new Error("Mock script exhausted: doGenerate ran longer than scripted.");
            }
            return next();
        },
    });
}
