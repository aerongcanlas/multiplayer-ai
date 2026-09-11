import type { RunMessageAuthor, RunUIMessage } from "@multiplayer-ai/domain";
import type { LockResult, RunStore } from "@multiplayer-ai/orchestration";

export function claimRun(
    store: RunStore,
    roomId: string,
    threadId: string,
    actor: RunMessageAuthor,
    runId: string,
    message: RunUIMessage,
): Promise<LockResult> {
    return store.claimRun(roomId, threadId, actor, runId, message);
}
