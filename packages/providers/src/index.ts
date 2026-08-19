import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import type { ChatProvider } from "@multiplayer-ai/domain";

export const DEFAULT_OPENAI_MODEL = "gpt-5-mini";

export function createChatModel(
    provider: ChatProvider,
    openAIModel = DEFAULT_OPENAI_MODEL,
) {
    return provider === "gemini"
        ? google("gemini-3.6-flash")
        : openai(openAIModel);
}
