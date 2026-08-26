import type { UIMessageChunk } from "ai";
import type {
    EffortLevel,
    ModelKey,
    RunEvent,
    RunMessageAuthor,
    RunMessageMetadata,
    RunStatus,
    RunUIMessage,
} from "@multiplayer-ai/domain";

export type RunInput = {
    runId: string;
    roomId: string;
    goal: string;
    model: ModelKey;
    effort?: EffortLevel;
};

export interface EventSink {
    emit(event: RunEvent): void | Promise<void>;
    merge?(stream: ReadableStream<UIMessageChunk>): void;
    setMessageMetadata?(metadata: RunMessageMetadata): void;
}

export type ThreadMessage = {
    message: RunUIMessage;
    seq: number;
};

export type ThreadRecord = {
    threadId: string;
    messages: Array<RunUIMessage>;
    status: RunStatus;
    runBy: RunMessageAuthor | null;
    lastSeq: number;
};

export type LockResult =
    | { acquired: true; threadId: string; messages: Array<RunUIMessage> }
    | { acquired: false; runBy: RunMessageAuthor | null };

export type RetireResult =
    | { retired: true; retiredThreadId: string; threadId: string }
    | { retired: false; runBy: RunMessageAuthor | null };

export type RunClaimOptions = {
    /** When false the claim never loses — the caller's policy refuses nobody. */
    exclusive?: boolean;
};

export const STALE_RUN_MS = 360_000;

export interface RunStore {
    loadFrom(
        roomId: string,
        actor: RunMessageAuthor,
        fromSeq: number,
    ): Promise<{
        threadId: string;
        status: RunStatus;
        runBy: RunMessageAuthor | null;
        messages: Array<ThreadMessage>;
    }>;
    /**
     * One conditional update: succeeds only where no live run holds the thread. Pass
     * `exclusive: false` to waive that predicate — see `features/runs/lock`.
     */
    acquireLock(
        roomId: string,
        actor: RunMessageAuthor,
        options?: RunClaimOptions,
    ): Promise<LockResult>;
    upsertMessage(threadId: string, message: RunUIMessage): Promise<number>;
    releaseLock(threadId: string, status: RunStatus): Promise<void>;
    retire(roomId: string, actor: RunMessageAuthor): Promise<RetireResult>;
}
