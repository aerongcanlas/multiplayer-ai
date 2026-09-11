import type {
    RunMessageAuthor,
    RunStatus,
    RunUIMessage,
} from "@multiplayer-ai/domain";
import {
    STALE_RUN_MS,
    type LockResult,
    type RetireResult,
    type RunStore,
    type ThreadMessage,
} from "./ports";

type MemoryThread = {
    id: string;
    roomId: string;
    retired: boolean;
    status: RunStatus;
    runBy: RunMessageAuthor | null;
    runStartedAt: number | null;
    runId: string | null;
    messages: Map<string, ThreadMessage>;
};

export function createInMemoryRunStore(): RunStore & {
    createThread(roomId: string): string;
} {
    const threads = new Map<string, MemoryThread>();
    const messageOwners = new Map<
        string,
        { threadId: string; runId: string }
    >();
    let nextSeq = 0;

    function openThread(roomId: string): MemoryThread {
        const thread: MemoryThread = {
            id: crypto.randomUUID(),
            roomId,
            retired: false,
            status: "finished",
            runBy: null,
            runStartedAt: null,
            runId: null,
            messages: new Map(),
        };
        threads.set(thread.id, thread);
        return thread;
    }

    function findThread(roomId: string, threadId: string): MemoryThread {
        const thread = threads.get(threadId);
        if (thread === undefined || thread.roomId !== roomId) {
            throw new Error("Thread not found");
        }
        return thread;
    }

    function expireDeadRun(thread: MemoryThread): MemoryThread {
        const startedAt = thread.runStartedAt;
        if (
            thread.status === "running" &&
            startedAt !== null &&
            Date.now() - startedAt > STALE_RUN_MS
        ) {
            thread.status = "failed";
            thread.runBy = null;
            thread.runStartedAt = null;
            thread.runId = null;
        }
        return thread;
    }

    function ordered(thread: MemoryThread): Array<ThreadMessage> {
        return [...thread.messages.values()].sort((a, b) => a.seq - b.seq);
    }

    return {
        /** Test/runtime helper: application thread creation is owned by the service API. */
        createThread(roomId: string): string {
            return openThread(roomId).id;
        },
        async loadFrom(roomId, _actor, threadId, fromSeq) {
            const thread = expireDeadRun(findThread(roomId, threadId));
            return {
                threadId: thread.id,
                status: thread.status,
                runBy: thread.runBy,
                retired: thread.retired,
                messages: ordered(thread).filter(
                    (entry) => entry.seq >= fromSeq,
                ),
            };
        },

        async claimRun(
            roomId,
            threadId,
            actor,
            runId,
            userMessage,
        ): Promise<LockResult> {
            const thread = expireDeadRun(findThread(roomId, threadId));
            if (thread.retired)
                throw Object.assign(new Error("Thread is archived"), {
                    code: "P0001",
                });
            const owner = messageOwners.get(userMessage.id);
            if (owner !== undefined) {
                if (owner.threadId !== threadId)
                    throw new Error("Message belongs to another thread");
                return { outcome: "already_accepted" };
            }
            if (thread.status === "running")
                throw Object.assign(new Error("Run is busy"), {
                    code: "55P03",
                });
            thread.status = "running";
            thread.runId = runId;
            thread.runBy = actor;
            thread.runStartedAt = Date.now();
            thread.messages.set(userMessage.id, {
                message: userMessage,
                seq: ++nextSeq,
            });
            messageOwners.set(userMessage.id, { threadId, runId });
            return { outcome: "accepted" };
        },

        async writeMessage(
            roomId,
            threadId,
            _actor,
            runId,
            message: RunUIMessage,
        ) {
            const thread = expireDeadRun(findThread(roomId, threadId));
            if (thread.status !== "running" || thread.runId !== runId)
                throw new Error("Run no longer owns thread");
            const owner = messageOwners.get(message.id);
            if (owner !== undefined && owner.threadId !== threadId)
                throw new Error("Message belongs to another thread");
            const existing = thread.messages.get(message.id);
            if (existing && owner?.runId !== runId)
                throw new Error("Message belongs to another run");
            const seq = existing?.seq ?? ++nextSeq;
            thread.messages.set(message.id, { message, seq });
            messageOwners.set(message.id, { threadId, runId });
            return seq;
        },

        async finalizeRun(roomId, threadId, _actor, runId, status) {
            const thread = expireDeadRun(findThread(roomId, threadId));
            if (thread.status !== "running" || thread.runId !== runId)
                return false;
            thread.status = status;
            thread.runBy = null;
            thread.runStartedAt = null;
            thread.runId = null;
            return true;
        },

        async retire(roomId, threadId): Promise<RetireResult> {
            const retired = expireDeadRun(findThread(roomId, threadId));
            if (retired.status === "running") {
                return { retired: false, runBy: retired.runBy };
            }
            retired.retired = true;
            retired.runBy = null;
            retired.runStartedAt = null;
            return {
                retired: true,
                retiredThreadId: retired.id,
                threadId: retired.id,
            };
        },
    };
}
