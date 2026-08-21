import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { ModelKey } from "@multiplayer-ai/domain";
import type { LanguageModel } from "ai";

export type ResolvedRunModel = {
    model: LanguageModel;
    providerOptions?: ProviderOptions;
};

const RUN_MODEL_REGISTRY: Record<ModelKey, () => ResolvedRunModel> = {
    "openai:gpt-5-mini": () => ({
        model: openai("gpt-5-mini"),
        providerOptions: { openai: { reasoningSummary: "auto" } },
    }),
    "openai:gpt-5": () => ({
        model: openai("gpt-5"),
        providerOptions: { openai: { reasoningSummary: "auto" } },
    }),
    "google:gemini-3.6-flash": () => ({
        model: google("gemini-3.6-flash"),
        providerOptions: {
            google: { thinkingConfig: { includeThoughts: true } },
        },
    }),
    "google:gemini-3.5-flash-lite": () => ({
        model: google("gemini-3.5-flash-lite"),
        providerOptions: {
            google: { thinkingConfig: { includeThoughts: true } },
        },
    }),
};

export function resolveModel(key: ModelKey): ResolvedRunModel {
    const factory = RUN_MODEL_REGISTRY[key];
    if (!factory) throw new Error(`Unsupported model: ${key}`);
    return factory();
}
