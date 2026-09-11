import type { RunMessageAuthor } from "@multiplayer-ai/domain";
import type { RunStore, ThreadRecord } from "./ports";

export async function loadThread(
    store: RunStore,
    roomId: string,
    threadId: string,
    actor: RunMessageAuthor,
    fromSeq = 0,
): Promise<ThreadRecord> {
    const {
        threadId: loadedThreadId,
        status,
        runBy,
        retired,
        messages,
    } = await store.loadFrom(roomId, actor, threadId, fromSeq);
    return {
        threadId: loadedThreadId,
        status,
        runBy,
        retired,
        messages: messages.map((entry) => entry.message),
        lastSeq: messages.at(-1)?.seq ?? 0,
    };
}
