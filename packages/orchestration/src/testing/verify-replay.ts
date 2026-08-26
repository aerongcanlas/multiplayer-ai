import type { ModelKey, RunUIMessage } from "@multiplayer-ai/domain";
import { buildReplay } from "../run/replay";

let nextId = 0;

function assistantMsg(
    text: string,
    inputTokens: number,
    model: ModelKey,
): RunUIMessage {
    return {
        id: `a-${nextId++}`,
        role: "assistant",
        parts: [{ type: "text", text, state: "done" }],
        metadata: { inputTokens, model },
    };
}

function userMsg(text: string): RunUIMessage {
    return { id: `u-${nextId++}`, role: "user", parts: [{ type: "text", text }] };
}

async function main() {
    // 1. Under threshold, same provider: no compaction, no reasoning strip.
    {
        const thread: Array<RunUIMessage> = [
            userMsg("hi"),
            assistantMsg("hello", 1000, "openai:gpt-5-mini"),
        ];
        const result = await buildReplay(thread, "openai:gpt-5-mini");
        console.log("1. under threshold:", { compacted: result.compacted });
        if (result.compacted) throw new Error("expected no compaction under threshold");
    }

    // 2. Over threshold (80% of 400,000 = 320,000): compaction fires.
    {
        const thread: Array<RunUIMessage> = [
            userMsg("hi"),
            assistantMsg("hello", 350_000, "openai:gpt-5-mini"),
        ];
        const result = await buildReplay(thread, "openai:gpt-5-mini");
        console.log("2. over threshold:", { compacted: result.compacted });
        if (!result.compacted) throw new Error("expected compaction over threshold");
    }

    // 3. No recorded usage at all (fresh room / mock mode gap): skip check, no compaction.
    {
        const thread: Array<RunUIMessage> = [userMsg("hi")];
        const result = await buildReplay(thread, "openai:gpt-5-mini");
        console.log("3. no recorded usage:", { compacted: result.compacted });
        if (result.compacted) throw new Error("expected no compaction with no recorded usage");
    }

    // 4. Cross-provider switch: reasoning stripped even though under threshold.
    {
        const thread: Array<RunUIMessage> = [
            userMsg("hi"),
            {
                id: "a-reasoning",
                role: "assistant",
                parts: [
                    { type: "reasoning", text: "internal google thought", state: "done" },
                    { type: "text", text: "hello", state: "done" },
                ],
                metadata: { inputTokens: 1000, model: "google:gemini-3.6-flash" },
            },
            userMsg("follow up"),
        ];
        const result = await buildReplay(thread, "openai:gpt-5-mini");
        const hasReasoning = result.modelMessages.some(
            (m) =>
                Array.isArray(m.content) &&
                m.content.some((p: unknown) => (p as { type?: string })?.type === "reasoning"),
        );
        console.log("4. cross-provider strip:", { compacted: result.compacted, hasReasoning });
        if (hasReasoning) throw new Error("expected reasoning stripped across providers");
        if (result.compacted) throw new Error("cross-provider strip should not itself count as compaction");
    }

    // 5. Hard strength always compacts, even under threshold.
    {
        const thread: Array<RunUIMessage> = [
            userMsg("hi"),
            assistantMsg("hello", 1000, "openai:gpt-5-mini"),
        ];
        const result = await buildReplay(thread, "openai:gpt-5-mini", "hard");
        console.log("5. hard strength:", { compacted: result.compacted });
        if (!result.compacted) throw new Error("expected hard strength to always compact");
    }

    console.log("\nAll buildReplay scenarios passed.");
}

await main();
