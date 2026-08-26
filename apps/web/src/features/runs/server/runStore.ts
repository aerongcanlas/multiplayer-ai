import type {
    RunMessageAuthor,
    RunMessageMetadata,
    RunStatus,
    RunUIMessage,
} from "@multiplayer-ai/domain";
import type { Json } from "@multiplayer-ai/db";
import {
    STALE_RUN_MS,
    type LockResult,
    type RetireResult,
    type RunStore,
    type ThreadMessage,
} from "@multiplayer-ai/orchestration";
import { createAdminClient } from "@/lib/supabase/server";

const THREAD_COLUMNS = `
    id,
    run_status,
    run_started_at,
    run_by,
    runner:user_profile!ai_thread_run_by_fkey (
        id,
        name
    )
` as const;

const MESSAGE_COLUMNS = "id, seq, role, parts, metadata" as const;

type ThreadRow = {
    id: string;
    run_status: string;
    run_started_at: string | null;
    run_by: string | null;
    runner: { id: string; name: string } | null;
};

type MessageRow = {
    id: string;
    seq: number;
    role: string;
    parts: Json;
    metadata: Json | null;
};

function isRunStatus(value: string): value is RunStatus {
    return (
        value === "running" ||
        value === "finished" ||
        value === "failed" ||
        value === "cancelled"
    );
}

/** A run that started before this instant is dead, whoever is asking. */
function staleBefore(): Date {
    return new Date(Date.now() - STALE_RUN_MS);
}

function isStale(row: ThreadRow): boolean {
    if (row.run_status !== "running") return false;
    if (row.run_started_at === null) return true;
    return Date.parse(row.run_started_at) < staleBefore().getTime();
}

function threadStatus(row: ThreadRow): RunStatus {
    if (isStale(row)) return "failed";
    return isRunStatus(row.run_status) ? row.run_status : "finished";
}

function livePredicate(): string {
    return [
        "run_status.neq.running",
        "run_started_at.is.null",
        `run_started_at.lt."${staleBefore().toISOString()}"`,
    ].join(",");
}

function threadRunner(row: ThreadRow): RunMessageAuthor | null {
    if (threadStatus(row) !== "running") return null;
    return row.runner;
}

function toRunMessage(row: MessageRow): RunUIMessage {
    return {
        id: row.id,
        role: row.role as RunUIMessage["role"],
        parts: row.parts as unknown as RunUIMessage["parts"],
        ...(row.metadata === null
            ? {}
            : { metadata: row.metadata as unknown as RunMessageMetadata }),
    };
}

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
    type Client = ReturnType<typeof createAdminClient>;

    async function assertMember(
        supabase: Client,
        roomId: string,
        userId: string,
    ): Promise<void> {
        const { data, error } = await supabase
            .from("room_member")
            .select("member_id")
            .eq("member_id", userId)
            .eq("room_id", roomId)
            .maybeSingle();

        if (error !== null || data === null) {
            throw new Error("User is not a member of this room");
        }
    }

    async function selectActiveThread(
        supabase: Client,
        roomId: string,
    ): Promise<ThreadRow | null> {
        const { data, error } = await supabase
            .from("ai_thread")
            .select(THREAD_COLUMNS)
            .eq("room_id", roomId)
            .is("retired_at", null)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle<ThreadRow>();

        if (error !== null) throw error;
        return data;
    }

    async function activeThread(
        supabase: Client,
        roomId: string,
    ): Promise<ThreadRow> {
        const existing = await selectActiveThread(supabase, roomId);
        if (existing !== null) return existing;

        const inserted = await supabase
            .from("ai_thread")
            .insert({ room_id: roomId })
            .select(THREAD_COLUMNS)
            .maybeSingle<ThreadRow>();

        if (inserted.data !== null) return inserted.data;

        const raced = await selectActiveThread(supabase, roomId);
        if (raced !== null) return raced;
        throw inserted.error ?? new Error("Could not open a thread for this room");
    }

    async function currentRunner(
        supabase: Client,
        roomId: string,
    ): Promise<RunMessageAuthor | null> {
        const row = await selectActiveThread(supabase, roomId);
        return row === null ? null : threadRunner(row);
    }

    async function messagesFrom(
        supabase: Client,
        threadId: string,
        fromSeq: number,
    ): Promise<Array<ThreadMessage>> {
        const { data, error } = await supabase
            .from("ai_message")
            .select(MESSAGE_COLUMNS)
            .eq("thread_id", threadId)
            .gte("seq", fromSeq)
            .order("seq", { ascending: true })
            .returns<Array<MessageRow>>();

        if (error !== null) throw error;
        return data.map((row) => ({ message: toRunMessage(row), seq: row.seq }));
    }

    return {
        async loadFrom(roomId, actor, fromSeq) {
            const supabase = createAdminClient();
            await assertMember(supabase, roomId, actor.id);

            const thread = await activeThread(supabase, roomId);
            return {
                threadId: thread.id,
                status: threadStatus(thread),
                runBy: threadRunner(thread),
                messages: await messagesFrom(supabase, thread.id, fromSeq),
            };
        },

        async acquireLock(roomId, actor, options): Promise<LockResult> {
            const supabase = createAdminClient();
            await assertMember(supabase, roomId, actor.id);

            const thread = await activeThread(supabase, roomId);

            const update = supabase
                .from("ai_thread")
                .update({
                    run_status: "running",
                    run_started_at: new Date().toISOString(),
                    run_by: actor.id,
                })
                .eq("id", thread.id);

            // The exclusivity predicate is the whole lock: zero rows back means it was held.
            // Waiving it leaves the same bookkeeping write, which simply always wins.
            const claimed =
                options?.exclusive === false ? update : update.or(livePredicate());

            const { data, error } = await claimed.select("id").maybeSingle();

            if (error !== null) throw error;
            if (data === null) return { acquired: false, runBy: await currentRunner(supabase, roomId) };

            const messages = await messagesFrom(supabase, data.id, 0);
            return {
                acquired: true,
                threadId: data.id,
                messages: messages.map((entry) => entry.message),
            };
        },

        async upsertMessage(threadId, message) {
            const supabase = createAdminClient();

            const { data, error } = await supabase
                .from("ai_message")
                .upsert(
                    {
                        id: message.id,
                        thread_id: threadId,
                        role: message.role,
                        parts: message.parts as unknown as Json,
                        metadata: (message.metadata ?? null) as Json,
                        author_id: message.metadata?.author?.id ?? null,
                    },
                    { onConflict: "id" },
                )
                .select("seq")
                .single();

            if (error !== null) throw error;
            return data.seq;
        },

        async releaseLock(threadId, status) {
            const supabase = createAdminClient();
            const { error } = await supabase
                .from("ai_thread")
                .update({
                    run_status: status,
                    run_started_at: null,
                    run_by: null,
                })
                .eq("id", threadId);

            if (error !== null) throw error;
        },

        async retire(roomId, actor): Promise<RetireResult> {
            const supabase = createAdminClient();
            await assertMember(supabase, roomId, actor.id);

            const thread = await activeThread(supabase, roomId);
            const { data, error } = await supabase
                .from("ai_thread")
                .update({ retired_at: new Date().toISOString() })
                .eq("id", thread.id)
                .is("retired_at", null)
                .or(livePredicate())
                .select("id")
                .maybeSingle();

            if (error !== null) throw error;
            if (data === null) return { retired: false, runBy: await currentRunner(supabase, roomId) };

            const opened = await activeThread(supabase, roomId);
            return { retired: true, retiredThreadId: thread.id, threadId: opened.id };
        },
    };
}
