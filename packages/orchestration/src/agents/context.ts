import {
  ContextSuggestionDraft,
  CONTEXT_AGENT_INSTRUCTIONS,
} from "@multiplayer-ai/domain/context-suggestions";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { Output, ToolLoopAgent, isStepCount, type LanguageModel } from "ai";

export function buildContextAgent(
  model: LanguageModel,
  providerOptions?: ProviderOptions,
) {
  return new ToolLoopAgent({
    model,
    instructions: CONTEXT_AGENT_INSTRUCTIONS,
    tools: {},
    stopWhen: isStepCount(1),
    output: Output.object({
      name: "ContextSuggestions",
      description:
        "A faithful summary and suggested prompts derived from selected room messages.",
      schema: ContextSuggestionDraft,
    }),
    providerOptions,
  });
}
