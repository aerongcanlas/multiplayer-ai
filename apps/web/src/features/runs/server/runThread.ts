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
    roomId: string,
    threadId: string,
    actor: RunMessageAuthor,
    runId: string,
) {
    let finishing: Promise<boolean> | undefined;
    let lastProgressBroadcastAt = 0;
    return {
        async publish(message: RunUIMessage) {
            const seq = await store.writeMessage(
                roomId,
                threadId,
                actor,
                runId,
                message,
            );
            const now = Date.now();
            if (now - lastProgressBroadcastAt >= 500) {
                lastProgressBroadcastAt = now;
                await broadcaster.send({
                    kind: "progress",
                    threadId,
                    status: "running",
                    runBy: actor,
                    seq,
                });
            }
        },

        finish(status: Exclude<RunStatus, "running">) {
            finishing ??= (async () => {
                try {
                    if (
                        await store.finalizeRun(
                            roomId,
                            threadId,
                            actor,
                            runId,
                            status,
                        )
                    ) {
                        await broadcaster.send({
                            kind: "status",
                            threadId,
                            status,
                            runBy: null,
                        });
                        return true;
                    }
                    return false;
                } finally {
                    await broadcaster.close();
                }
            })();
            return finishing;
        },
    };
}

/** Ownership outlives provider execution and every queued snapshot write. */
export async function executeOwnedRun(options: {
    execute(): Promise<void>;
    settled(): Promise<void>;
    finish(status: Exclude<RunStatus, "running">): Promise<boolean>;
    requestSignal: AbortSignal;
    deadlineSignal: AbortSignal;
    reportError(error: unknown): void;
}): Promise<{ status: Exclude<RunStatus, "running">; finalized: boolean }> {
    let status: Exclude<RunStatus, "running"> = "failed";
    try {
        await options.execute();
        status = "finished";
    } catch (error) {
        options.reportError(error);
    } finally {
        if (options.deadlineSignal.aborted) status = "failed";
        else if (options.requestSignal.aborted) status = "cancelled";
        try {
            await options.settled();
        } catch (error) {
            status = "failed";
            options.reportError(error);
        }
        if (options.deadlineSignal.aborted) status = "failed";
        else if (options.requestSignal.aborted && status === "finished")
            status = "cancelled";
    }
    return { status, finalized: await options.finish(status) };
}
