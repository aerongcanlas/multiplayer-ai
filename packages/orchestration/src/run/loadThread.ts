import type { RunMessageAuthor } from "@multiplayer-ai/domain";
import type { RunStore, ThreadRecord } from "./ports";

export async function loadThread(
    store: RunStore,
    roomId: string,
    actor: RunMessageAuthor,
): Promise<ThreadRecord> {
    const { threadId, status, runBy, messages } = await store.loadFrom(
        roomId,
        actor,
        0,
    );
    return {
        threadId,
        status,
        runBy,
        messages: messages.map((entry) => entry.message),
        lastSeq: messages.at(-1)?.seq ?? 0,
    };
}
