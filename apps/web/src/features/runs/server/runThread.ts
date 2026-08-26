import type {
    RunMessageAuthor,
    RunStatus,
    RunUIMessage,
} from "@multiplayer-ai/domain";
import type { RunStore } from "@multiplayer-ai/orchestration";
import type { RunBroadcaster } from "@/features/runs/server/runBroadcast";

export function openRunThread(
    store: RunStore,
    broadcaster: RunBroadcaster,
    threadId: string,
    actor: RunMessageAuthor,
) {
    return {
        async publish(message: RunUIMessage) {
            const seq = await store.upsertMessage(threadId, message);
            await broadcaster.send({
                kind: "progress",
                threadId,
                status: "running",
                runBy: actor,
                seq,
            });
        },
        
        async finish(status: RunStatus) {
            try {
                await store.releaseLock(threadId, status);
            } catch (error) {
                console.error(`[run thread ${threadId}]`, error);
            }
            await broadcaster.send({ kind: "status", threadId, status, runBy: null });
            await broadcaster.close();
        },
    };
}
