import { Verdict } from "@multiplayer-ai/domain";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import {
    Output,
    ToolLoopAgent,
    isStepCount,
    pruneMessages,
    type StopCondition,
    type ToolSet,
    type LanguageModel,
} from "ai";
import { buildDelegateTool } from "./scout";
import { createWebSearchTool, type ToolDeps } from "../tools";

const INSTRUCTIONS = `You are @lead. You own this run end to end.

Rules:
- Search the web yourself for quick lookups. Delegate to @scout only when a question
  needs wide or deep research — several searches, cross-referencing, synthesis. Your
  context is the scarce resource; @scout's is disposable.
- You have no filesystem access or write capability. Report research and recommendations.
- End with a short report of what you found and what you could not determine.
- If nothing should be done, say so plainly and explain why. Doing nothing is a valid outcome.`;

function withinTokenBudget<TOOLS extends ToolSet>(
    budget: number,
): StopCondition<TOOLS> {
    return ({ steps }) => {
        const spent = steps.reduce(
            (total, step) => total + (step.usage?.outputTokens ?? 0),
            0,
        );
        return spent >= budget;
    };
}

export function buildLead(
    model: LanguageModel,
    deps: ToolDeps,
    providerOptions?: ProviderOptions,
) {
    return new ToolLoopAgent({
        model,
        instructions: INSTRUCTIONS,
        tools: {
            webSearch: createWebSearchTool(deps),
            delegate: buildDelegateTool(model, deps),
        },
        stopWhen: [
            isStepCount(deps.profile.leadMaxSteps),
            withinTokenBudget(deps.profile.tokenBudget),
        ],
        prepareStep: ({ messages }) => ({ messages: pruneMessages({ messages }) }),
        providerOptions,
    });
}

const VERIFY_INSTRUCTIONS = `You are a verifier. You did not do the work.

Given a goal and a report of what was done, decide whether the goal was actually met.
Be skeptical: identify unsupported claims or unmet goals. Return ok=false with concrete
issues if anything is unmet, otherwise ok=true with an empty list.`;

export function buildVerifier(model: LanguageModel) {
    return new ToolLoopAgent({
        model,
        instructions: VERIFY_INSTRUCTIONS,
        tools: {},
        stopWhen: isStepCount(6),
        output: Output.object({ schema: Verdict }),
    });
}
