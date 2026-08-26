import type { RunMessageAuthor, RunStatus, RunUIMessage } from "@multiplayer-ai/domain";
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
    messages: Map<string, ThreadMessage>;
};


export function createInMemoryRunStore(): RunStore {
    const threads = new Map<string, MemoryThread>();
    let nextSeq = 0;

    function openThread(roomId: string): MemoryThread {
        const thread: MemoryThread = {
            id: crypto.randomUUID(),
            roomId,
            retired: false,
            status: "finished",
            runBy: null,
            runStartedAt: null,
            messages: new Map(),
        };
        threads.set(thread.id, thread);
        return thread;
    }

    function activeThread(roomId: string): MemoryThread {
        for (const thread of threads.values()) {
            if (thread.roomId === roomId && !thread.retired) return thread;
        }
        return openThread(roomId);
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
        }
        return thread;
    }

    function ordered(thread: MemoryThread): Array<ThreadMessage> {
        return [...thread.messages.values()].sort((a, b) => a.seq - b.seq);
    }

    return {
        async loadFrom(roomId, _actor, fromSeq) {
            const thread = expireDeadRun(activeThread(roomId));
            return {
                threadId: thread.id,
                status: thread.status,
                runBy: thread.runBy,
                messages: ordered(thread).filter((entry) => entry.seq >= fromSeq),
            };
        },

        async acquireLock(roomId, actor, options): Promise<LockResult> {
            const thread = expireDeadRun(activeThread(roomId));
            if (options?.exclusive !== false && thread.status === "running") {
                return { acquired: false, runBy: thread.runBy };
            }
            thread.status = "running";
            thread.runBy = actor;
            thread.runStartedAt = Date.now();
            return {
                acquired: true,
                threadId: thread.id,
                messages: ordered(thread).map((entry) => entry.message),
            };
        },

        async upsertMessage(threadId, message: RunUIMessage) {
            const thread = threads.get(threadId);
            if (thread === undefined) {
                throw new Error(`Unknown thread ${threadId}`);
            }
            const existing = thread.messages.get(message.id);
            const seq = existing?.seq ?? ++nextSeq;
            thread.messages.set(message.id, { message, seq });
            return seq;
        },

        async releaseLock(threadId, status) {
            const thread = threads.get(threadId);
            if (thread === undefined) return;
            thread.status = status;
            thread.runBy = null;
            thread.runStartedAt = null;
        },

        async retire(roomId): Promise<RetireResult> {
            const retired = expireDeadRun(activeThread(roomId));
            if (retired.status === "running") {
                return { retired: false, runBy: retired.runBy };
            }
            retired.retired = true;
            retired.runBy = null;
            retired.runStartedAt = null;
            return {
                retired: true,
                retiredThreadId: retired.id,
                threadId: openThread(roomId).id,
            };
        },
    };
}
