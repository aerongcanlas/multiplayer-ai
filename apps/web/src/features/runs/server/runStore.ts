import type { RunMessageAuthor, RunUIMessage } from "@multiplayer-ai/domain";
import type { Json } from "@multiplayer-ai/db";
import { STALE_RUN_MS, type RunStore } from "@multiplayer-ai/orchestration";
import { createAdminClient } from "@/lib/supabase/server";
import { createThreadStore } from "@/features/threads/server/threadStore";

export async function readUserProfile(
    userId: string,
): Promise<RunMessageAuthor | null> {
    const { data } = await createAdminClient()
        .from("user_profile")
        .select("id, name")
        .eq("id", userId)
        .maybeSingle();
    return data;
}

export function createSupabaseRunStore(): RunStore {
    return {
        async loadFrom(roomId, actor, threadId, fromSeq) {
            const client = createAdminClient();
            const threads = createThreadStore(client);
            const thread = await threads.get(roomId, threadId, actor.id);
            const { data: state, error } = await client
                .from("ai_thread")
                .select(
                    "run_started_at, runner:user_profile!ai_thread_run_by_fkey(id, name)",
                )
                .eq("id", threadId)
                .eq("room_id", roomId)
                .single();
            if (error) throw error;
            const stale =
                thread.runStatus === "running" &&
                (state.run_started_at === null ||
                    Date.parse(state.run_started_at) <
                        Date.now() - STALE_RUN_MS);
            const status = stale ? "failed" : thread.runStatus;
            return {
                threadId,
                status,
                runBy: status === "running" ? state.runner : null,
                messages: thread.messages
                    .filter((entry) => entry.seq >= fromSeq)
                    .map((entry) => ({
                        seq: entry.seq,
                        message: {
                            id: entry.id,
                            role: entry.role,
                            parts: entry.parts,
                            ...(entry.metadata
                                ? { metadata: entry.metadata }
                                : {}),
                        } as RunUIMessage,
                    })),
            };
        },
        async claimRun(roomId, threadId, actor, runId, message) {
            const result = await createThreadStore().claimRun({
                roomId,
                threadId,
                actorId: actor.id,
                runId,
                userMessageId: message.id,
                parts: message.parts as Json,
                metadata: (message.metadata ?? null) as Json,
            });
            return { outcome: result.outcome };
        },
        async writeMessage(roomId, threadId, actor, runId, message) {
            const result = await createThreadStore().writeMessage({
                roomId,
                threadId,
                actorId: actor.id,
                runId,
                messageId: message.id,
                role: message.role,
                parts: message.parts as Json,
                metadata: (message.metadata ?? null) as Json,
                authorId: message.metadata?.author?.id,
            });
            return result.seq;
        },
        async finalizeRun(roomId, threadId, actor, runId, status) {
            const result = await createThreadStore().finalizeRun({
                roomId,
                threadId,
                actorId: actor.id,
                runId,
                status,
            });
            return result.outcome === "finalized";
        },
        async retire(roomId, threadId, actor) {
            await createThreadStore().archive(roomId, threadId, actor.id);
            return { retired: true, retiredThreadId: threadId, threadId };
        },
    };
}
