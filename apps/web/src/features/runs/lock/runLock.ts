import type { RunMessageAuthor } from "@multiplayer-ai/domain";
import type { LockResult, RunStore } from "@multiplayer-ai/orchestration";
import { runLockEnabled } from "./runLockConfig";

export function claimRun(
    store: RunStore,
    roomId: string,
    actor: RunMessageAuthor,
): Promise<LockResult> {
    return store.acquireLock(roomId, actor, { exclusive: runLockEnabled });
}
