import {
    getContextWindow,
    getModelProvider,
    type ModelKey,
    type RunUIMessage,
} from "@multiplayer-ai/domain";
import { convertToModelMessages, pruneMessages, type ModelMessage } from "ai";

export type PruneStrength = "auto" | "hard";

export type ReplayResult = {
    modelMessages: Array<ModelMessage>;
    compacted: boolean;
};

/** Compact once the last recorded call used this fraction of the target model's window. */
const COMPACTION_THRESHOLD_RATIO = 0.8;

export async function buildReplay(
    thread: Array<RunUIMessage>,
    targetModel: ModelKey,
    strength: PruneStrength = "auto",
): Promise<ReplayResult> {
    const lastUsage = thread.findLast(
        (message) =>
            message.role === "assistant" && message.metadata?.usage !== undefined,
    )?.metadata?.usage;

    const overThreshold =
        lastUsage !== undefined &&
        lastUsage.inputTokens / getContextWindow(targetModel) >=
            COMPACTION_THRESHOLD_RATIO;

    const crossProvider =
        lastUsage !== undefined &&
        getModelProvider(lastUsage.model) !== getModelProvider(targetModel);

    const converted = await convertToModelMessages(thread, {
        ignoreIncompleteToolCalls: true,
    });

    const shouldPrune = strength === "hard" || overThreshold;
    if (!shouldPrune && !crossProvider) {
        return { modelMessages: converted, compacted: false };
    }

    const modelMessages = pruneMessages({
        messages: converted,
        reasoning: "all",
        toolCalls: shouldPrune
            ? strength === "hard"
                ? "before-last-message"
                : "before-last-2-messages"
            : "none",
    });

    return { modelMessages, compacted: shouldPrune };
}
