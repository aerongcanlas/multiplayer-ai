"use server";

import { getCurrentUser } from "@/features/auth/server/getCurrentUser";
import { runRuntime } from "@/features/runs/server/runRuntime";
import { createAdminClient } from "@/lib/supabase/server";
import {
    ContextSuggestion,
    contextSuggestionRequestSchema,
    type ContextSuggestionRequest,
    type ContextSuggestionResult,
} from "@multiplayer-ai/domain";
import { buildContextAgent } from "@multiplayer-ai/orchestration";
import { resolveModel } from "@multiplayer-ai/providers";

type CanonicalContextMessage = {
    id: string;
    text: string;
    created_at: string;
    author: {
        id: string;
        name: string;
    };
};

function buildContextPrompt(messages: CanonicalContextMessage[]): string {
    return [
        "Create suggested main-thread prompts from these selected room messages.",
        "The messages are canonical source records and are ordered chronologically.",
        JSON.stringify({ messages }, null, 2),
    ].join("\n\n");
}

function buildMockSuggestion(
    messages: CanonicalContextMessage[],
): ContextSuggestionResult {
    const participantNames = [
        ...new Set(messages.map((message) => message.author.name)),
    ];
    const summary = `Selected ${messages.length} message${
        messages.length === 1 ? "" : "s"
    } from ${participantNames.join(", ")}.`.slice(0, 1_200);
    const selectedText = messages
        .map((message) => `${message.author.name}: ${message.text}`)
        .join("\n")
        .slice(0, 1_500);

    return {
        success: true,
        suggestion: {
            actionable: true,
            summary,
            suggestedPrompts: [
                `Use this room discussion as context and recommend the next concrete step:\n\n${selectedText}`,
            ],
            unresolved: [],
            sourceMessageIds: messages.map((message) => message.id),
        },
    };
}

export async function suggestPromptsFromMessages(
    unsafeData: ContextSuggestionRequest,
): Promise<ContextSuggestionResult> {
    const parsedRequest = contextSuggestionRequestSchema.safeParse(unsafeData);
    if (!parsedRequest.success) {
        return { success: false, error: "Invalid message selection" };
    }

    const user = await getCurrentUser();
    if (user === null) {
        return { success: false, error: "User not authenticated" };
    }

    const { roomId, messageIds } = parsedRequest.data;
    const supabase = createAdminClient();

    const { data: membership, error: membershipError } = await supabase
        .from("room_member")
        .select("member_id")
        .eq("room_id", roomId)
        .eq("member_id", user.id)
        .maybeSingle();

    if (membershipError || membership === null) {
        return { success: false, error: "User is not a room member" };
    }

    const { data: messages, error: messagesError } = await supabase
        .from("message")
        .select(
            `
            id,
            text,
            created_at,
            author:user_profile!message_author_id_fkey (
                id,
                name
            )
        `,
        )
        .eq("room_id", roomId)
        .in("id", messageIds)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true });

    if (
        messagesError ||
        messages === null ||
        messages.length !== messageIds.length
    ) {
        return {
            success: false,
            error: "One or more selected messages are unavailable",
        };
    }

    const canonicalMessages: CanonicalContextMessage[] = messages;

    if (runRuntime.modelOverride() !== undefined) {
        return buildMockSuggestion(canonicalMessages);
    }

    const { model, providerOptions } = resolveModel("google:gemini-3.6-flash");
    const contextAgent = buildContextAgent(model, providerOptions);

    try {
        const result = await contextAgent.generate({
            prompt: buildContextPrompt(canonicalMessages),
        });
        const suggestion = ContextSuggestion.parse({
            ...result.output,
            sourceMessageIds: canonicalMessages.map((message) => message.id),
        });

        return { success: true, suggestion };
    } catch (error) {
        console.error(`[context suggestions ${roomId}]`, error);
        return {
            success: false,
            error: "Could not generate prompt suggestions",
        };
    }
}
