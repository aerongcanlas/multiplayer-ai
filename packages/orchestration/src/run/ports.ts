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
    threadId: string;
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

export type LockResult = { outcome: "accepted" | "already_accepted" };

export type RetireResult =
    | { retired: true; retiredThreadId: string; threadId: string }
    | { retired: false; runBy: RunMessageAuthor | null };

export const STALE_RUN_MS = 360_000;

export interface RunStore {
    loadFrom(
        roomId: string,
        actor: RunMessageAuthor,
        threadId: string,
        fromSeq: number,
    ): Promise<{
        threadId: string;
        status: RunStatus;
        runBy: RunMessageAuthor | null;
        messages: Array<ThreadMessage>;
    }>;
    claimRun(
        roomId: string,
        threadId: string,
        actor: RunMessageAuthor,
        runId: string,
        userMessage: RunUIMessage,
    ): Promise<LockResult>;
    writeMessage(
        roomId: string,
        threadId: string,
        actor: RunMessageAuthor,
        runId: string,
        message: RunUIMessage,
    ): Promise<number>;
    finalizeRun(
        roomId: string,
        threadId: string,
        actor: RunMessageAuthor,
        runId: string,
        status: Exclude<RunStatus, "running">,
    ): Promise<boolean>;
    retire(
        roomId: string,
        threadId: string,
        actor: RunMessageAuthor,
    ): Promise<RetireResult>;
}
