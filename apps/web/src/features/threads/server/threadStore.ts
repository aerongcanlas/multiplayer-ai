import type { Database, Json } from "@multiplayer-ai/db";
import type { RunStatus, RunUIMessage } from "@multiplayer-ai/domain";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";

export type ThreadTitleSource = "default" | "auto" | "manual";

export type ThreadSummary = {
  id: string;
  roomId: string;
  createdAt: string;
  retiredAt: string | null;
  title: string;
  titleSource: ThreadTitleSource;
  runStatus: RunStatus;
  currentRunId: string | null;
};

export type StoredThreadMessage = {
  id: string;
  seq: number;
  threadId: string;
  role: RunUIMessage["role"];
  parts: RunUIMessage["parts"];
  metadata: RunUIMessage["metadata"];
  authorId: string | null;
  createdAt: string;
  runId: string | null;
};

export type ThreadRecord = ThreadSummary & {
  messages: Array<StoredThreadMessage>;
};

export type ClaimResult =
  | {
      outcome: "accepted";
      thread: ThreadSummary;
      runId: string;
      acceptedMessageSeq: number;
    }
  | {
      outcome: "already_accepted";
      thread: ThreadSummary;
      runId: string | null;
      acceptedMessageSeq: number;
    };

export class ThreadStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ThreadStoreError";
    this.code = code;
  }
}

type Client = SupabaseClient<Database>;

const THREAD_COLUMNS =
  "id, room_id, created_at, retired_at, title, title_source, run_status, current_run_id" as const;
const MESSAGE_COLUMNS =
  "id, seq, thread_id, role, parts, metadata, author_id, created_at, run_id" as const;

type ThreadRow = Database["public"]["Tables"]["ai_thread"]["Row"];
type ThreadSummaryRow = Pick<
  ThreadRow,
  | "id"
  | "room_id"
  | "created_at"
  | "retired_at"
  | "title"
  | "title_source"
  | "run_status"
  | "current_run_id"
>;
type MessageRow = Database["public"]["Tables"]["ai_message"]["Row"];

function asRunStatus(value: string): RunStatus {
  if (
    value === "running" ||
    value === "finished" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new ThreadStoreError("invalid_state", `Unknown run status: ${value}`);
}

function asTitleSource(value: string): ThreadTitleSource {
  if (value === "default" || value === "auto" || value === "manual") {
    return value;
  }
  throw new ThreadStoreError("invalid_state", `Unknown title source: ${value}`);
}

function summary(row: ThreadSummaryRow): ThreadSummary {
  return {
    id: row.id,
    roomId: row.room_id,
    createdAt: row.created_at,
    retiredAt: row.retired_at,
    title: row.title,
    titleSource: asTitleSource(row.title_source),
    runStatus: asRunStatus(row.run_status),
    currentRunId: row.current_run_id,
  };
}

function message(row: MessageRow): StoredThreadMessage {
  return {
    id: row.id,
    seq: row.seq,
    threadId: row.thread_id,
    role: row.role as RunUIMessage["role"],
    parts: row.parts as unknown as RunUIMessage["parts"],
    metadata: row.metadata as unknown as RunUIMessage["metadata"],
    authorId: row.author_id,
    createdAt: row.created_at,
    runId: row.run_id,
  };
}

function throwSupabaseError(error: { code?: string; message: string }): never {
  throw new ThreadStoreError(error.code ?? "database_error", error.message);
}

/**
 * Server-only persistence boundary for room threads. All mutations are RPCs
 * backed by row locks; reads use the admin client only after membership is
 * checked in this process and again inside each mutation function.
 */
export function createThreadStore(client: Client = createAdminClient()) {
  async function assertMember(roomId: string, actorId: string): Promise<void> {
    const { data, error } = await client
      .from("room_member")
      .select("member_id")
      .eq("room_id", roomId)
      .eq("member_id", actorId)
      .maybeSingle();
    if (error !== null) throwSupabaseError(error);
    if (data === null)
      throw new ThreadStoreError("not_member", "Actor is not a room member");
  }

  async function getSummary(
    roomId: string,
    threadId: string,
    actorId: string,
  ): Promise<ThreadSummary> {
    await assertMember(roomId, actorId);
    const { data, error } = await client
      .from("ai_thread")
      .select(THREAD_COLUMNS)
      .eq("id", threadId)
      .eq("room_id", roomId)
      .maybeSingle();
    if (error !== null) throwSupabaseError(error);
    if (data === null)
      throw new ThreadStoreError("not_found", "Thread not found");
    return summary(data);
  }

  async function list(
    roomId: string,
    actorId: string,
    options: { archived?: boolean; limit?: number } = {},
  ): Promise<Array<ThreadSummary>> {
    await assertMember(roomId, actorId);
    const archived = options.archived ?? false;
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 50);
    let query = client
      .from("ai_thread")
      .select(THREAD_COLUMNS)
      .eq("room_id", roomId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);
    query = archived
      ? query.not("retired_at", "is", null)
      : query.is("retired_at", null);
    const { data, error } = await query;
    if (error !== null) throwSupabaseError(error);
    return data.map(summary);
  }

  async function get(
    roomId: string,
    threadId: string,
    actorId: string,
  ): Promise<ThreadRecord> {
    const thread = await getSummary(roomId, threadId, actorId);
    const { data, error } = await client
      .from("ai_message")
      .select(MESSAGE_COLUMNS)
      .eq("thread_id", threadId)
      .order("seq", { ascending: true });
    if (error !== null) throwSupabaseError(error);
    return { ...thread, messages: data.map(message) };
  }

  async function create(
    roomId: string,
    actorId: string,
    creationId?: string,
  ): Promise<ThreadSummary> {
    const { data, error } = await client
      .rpc("create_ai_thread", {
        p_room_id: roomId,
        p_actor_id: actorId,
        ...(creationId === undefined ? {} : { p_creation_id: creationId }),
      })
      .single();
    if (error !== null) throwSupabaseError(error);
    return summary({
      id: data.thread_id,
      room_id: data.room_id,
      created_at: data.created_at,
      retired_at: data.retired_at,
      title: data.title,
      title_source: data.title_source,
      run_status: data.run_status,
      current_run_id: data.current_run_id,
    });
  }

  async function claimRun(input: {
    roomId: string;
    threadId: string;
    actorId: string;
    runId: string;
    userMessageId: string;
    parts: Json;
    metadata?: Json;
  }): Promise<ClaimResult> {
    const { data, error } = await client
      .rpc("claim_ai_thread_run", {
        p_room_id: input.roomId,
        p_thread_id: input.threadId,
        p_actor_id: input.actorId,
        p_run_id: input.runId,
        p_user_message_id: input.userMessageId,
        p_parts: input.parts,
        p_metadata: input.metadata ?? null,
      })
      .single();
    if (error !== null) throwSupabaseError(error);
    const thread: ThreadSummary = {
      id: data.thread_id,
      roomId: input.roomId,
      createdAt: "",
      retiredAt: null,
      title: data.title,
      titleSource: asTitleSource(data.title_source),
      runStatus: asRunStatus(data.run_status),
      currentRunId: data.run_id,
    };
    if (data.outcome === "already_accepted") {
      return {
        outcome: "already_accepted",
        thread,
        runId: data.run_id,
        acceptedMessageSeq: data.accepted_message_seq,
      };
    }
    if (data.outcome !== "accepted") {
      throw new ThreadStoreError(
        "invalid_state",
        `Unknown claim outcome: ${data.outcome}`,
      );
    }
    return {
      outcome: "accepted",
      thread,
      runId: input.runId,
      acceptedMessageSeq: data.accepted_message_seq,
    };
  }

  async function writeMessage(input: {
    roomId: string;
    threadId: string;
    actorId: string;
    runId: string;
    messageId: string;
    role: "user" | "assistant" | "system";
    parts: Json;
    metadata?: Json;
    authorId?: string;
  }): Promise<{ messageId: string; seq: number; outcome: string }> {
    const { data, error } = await client
      .rpc("write_ai_thread_message", {
        p_room_id: input.roomId,
        p_thread_id: input.threadId,
        p_actor_id: input.actorId,
        p_run_id: input.runId,
        p_message_id: input.messageId,
        p_role: input.role,
        p_parts: input.parts,
        p_metadata: input.metadata ?? null,
        ...(input.authorId === undefined
          ? {}
          : { p_author_id: input.authorId }),
      })
      .single();
    if (error !== null) throwSupabaseError(error);
    return { messageId: data.message_id, seq: data.seq, outcome: data.outcome };
  }

  async function finalizeRun(input: {
    roomId: string;
    threadId: string;
    actorId: string;
    runId: string;
    status: Exclude<RunStatus, "running">;
  }): Promise<{ outcome: string; status: RunStatus }> {
    const { data, error } = await client
      .rpc("finalize_ai_thread_run", {
        p_room_id: input.roomId,
        p_thread_id: input.threadId,
        p_actor_id: input.actorId,
        p_run_id: input.runId,
        p_status: input.status,
      })
      .single();
    if (error !== null) throwSupabaseError(error);
    return { outcome: data.outcome, status: asRunStatus(data.run_status) };
  }

  async function archive(roomId: string, threadId: string, actorId: string) {
    const { data, error } = await client
      .rpc("archive_ai_thread", {
        p_room_id: roomId,
        p_thread_id: threadId,
        p_actor_id: actorId,
      })
      .single();
    if (error !== null) throwSupabaseError(error);
    return {
      outcome: data.outcome,
      threadId: data.thread_id,
      retiredAt: data.retired_at,
    };
  }

  async function restore(roomId: string, threadId: string, actorId: string) {
    const { data, error } = await client
      .rpc("restore_ai_thread", {
        p_room_id: roomId,
        p_thread_id: threadId,
        p_actor_id: actorId,
      })
      .single();
    if (error !== null) throwSupabaseError(error);
    return {
      outcome: data.outcome,
      threadId: data.thread_id,
      retiredAt: data.retired_at,
    };
  }

  async function rename(
    roomId: string,
    threadId: string,
    actorId: string,
    title: string,
  ) {
    const { data, error } = await client
      .rpc("rename_ai_thread", {
        p_room_id: roomId,
        p_thread_id: threadId,
        p_actor_id: actorId,
        p_title: title,
      })
      .single();
    if (error !== null) throwSupabaseError(error);
    return {
      threadId: data.thread_id,
      title: data.title,
      titleSource: asTitleSource(data.title_source),
    };
  }

  return {
    list,
    get,
    create,
    claimRun,
    writeMessage,
    finalizeRun,
    archive,
    restore,
    rename,
  };
}

export type ThreadStore = ReturnType<typeof createThreadStore>;
