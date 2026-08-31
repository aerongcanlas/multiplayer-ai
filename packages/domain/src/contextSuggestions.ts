import { z } from "zod";

export const MAX_CONTEXT_MESSAGES = 100;

export const contextSuggestionRequestSchema = z.object({
    roomId: z.uuid(),
    messageIds: z
        .array(z.uuid())
        .min(1)
        .max(MAX_CONTEXT_MESSAGES)
        .refine(
            (messageIds) => new Set(messageIds).size === messageIds.length,
            "Message IDs must be unique",
        ),
});

export type ContextSuggestionRequest = z.infer<
    typeof contextSuggestionRequestSchema
>;

export const ContextSuggestionDraft = z.object({
    actionable: z.boolean(),
    summary: z
        .string()
        .trim()
        .min(1)
        .max(1_200)
        .describe(
            "A faithful summary of decisions, constraints, disagreements, and open questions.",
        ),
    suggestedPrompts: z
        .array(z.string().trim().min(1).max(2_000))
        .min(1)
        .max(3)
        .describe(
            "Standalone prompts the user could submit to the main AI thread.",
        ),
    unresolved: z
        .array(z.string().trim().min(1).max(300))
        .max(5)
        .describe("Important unanswered questions or disagreements."),
});

export type ContextSuggestionDraft = z.infer<typeof ContextSuggestionDraft>;

export const ContextSuggestion = ContextSuggestionDraft.extend({
    sourceMessageIds: z.array(z.uuid()).min(1).max(MAX_CONTEXT_MESSAGES),
});

export type ContextSuggestion = z.infer<typeof ContextSuggestion>;

export type ContextSuggestionResult =
    | { success: true; suggestion: ContextSuggestion }
    | { success: false; error: string };
