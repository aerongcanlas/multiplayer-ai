import { ScoutBrief } from "@multiplayer-ai/domain";
import { Output, ToolLoopAgent, isStepCount, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { createWebSearchTool, type ToolDeps } from "../tools";

const INSTRUCTIONS = `You are @scout, a read-only researcher.

Investigate the task using web search. You cannot modify anything and you cannot
delegate — you are the bottom of the stack.

Your entire value is compression: you may read a lot, but you return a short brief.
Put anything you could not determine in "gaps" — the lead uses that to decide
whether a second look is worth it.`;

function buildScout(model: LanguageModel, deps: ToolDeps) {
    return new ToolLoopAgent({
        model,
        instructions: INSTRUCTIONS,
        tools: { webSearch: createWebSearchTool(deps) },
        stopWhen: isStepCount(deps.profile.scoutMaxSteps),
        output: Output.object({ schema: ScoutBrief }),
    });
}

export function buildDelegateTool(model: LanguageModel, deps: ToolDeps) {
    return tool({
        description:
            "Delegate a self-contained research task to @scout. Returns a short cited brief. " +
            "Use this for anything that would require reading a lot to answer.",
        inputSchema: z.object({
            task: z
                .string()
                .describe("A self-contained brief. @scout cannot see your conversation."),
        }),
        execute: async ({ task }, { abortSignal }) => {
            const startedAt = Date.now();
            await deps.sink.emit({
                kind: "run.delegated",
                runId: deps.runId,
                persona: "scout",
                task,
            });

            const scout = buildScout(model, deps);
            let brief: ScoutBrief;
            try {
                const result = await scout.generate({ prompt: task, abortSignal });
                brief = result.output;
            } catch (error) {
                await deps.sink.emit({
                    kind: "run.delegate.failed",
                    runId: deps.runId,
                    persona: "scout",
                    ms: Date.now() - startedAt,
                    error: error instanceof Error ? error.message : String(error),
                });
                throw error;
            }

            await deps.sink.emit({
                kind: "run.delegate.done",
                runId: deps.runId,
                persona: "scout",
                ms: Date.now() - startedAt,
                summary: brief.summary,
                confidence: brief.confidence,
            });

            return brief;
        },
        /**
         * The asymmetry that makes subagents worth their latency: the user can
         * see the whole delegation in the event log, the parent model sees ~1k
         * tokens of it.
         */
        toModelOutput: ({ output }) => ({
            type: "text",
            value: [
                output.summary,
                output.findings.map((f) => `- ${f.claim} [${f.source}]`).join("\n"),
                output.gaps.length ? `Gaps: ${output.gaps.join("; ")}` : "",
                `Confidence: ${output.confidence}`,
            ]
                .filter(Boolean)
                .join("\n\n"),
        }),
    });
}
