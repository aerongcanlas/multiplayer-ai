import type {
    RunEvent,
    RunMessageMetadata,
    RunStatus,
    RunUIMessage,
} from "@multiplayer-ai/domain";
import type { EventSink } from "@multiplayer-ai/orchestration";
import {
    readUIMessageStream,
    type InferUIMessageChunk,
    type UIMessageStreamWriter,
} from "ai";

const SNAPSHOT_INTERVAL_MS = 300;

export type SnapshotPersistence = {
    assistantMessageId: string;
    persist(message: RunUIMessage): Promise<void>;
};

export type RunEventSink = {
    sink: EventSink;
    settled(): Promise<void>;
    finish(status: Exclude<RunStatus, "running">): void;
};

export function createRunEventSink(
    writer: UIMessageStreamWriter<RunUIMessage>,
    persistence: SnapshotPersistence,
): RunEventSink {
    let snapshot: RunUIMessage | undefined;
    let lastPersistedAt = 0;
    let queue: Promise<void> = Promise.resolve();
    let failure: unknown;
    let terminal: RunEvent | undefined;
    let snapshotDirty = false;

    function writeEvent(event: RunEvent) {
        const chunk = {
            type: `data-${event.kind}`,
            data: event,
            ...(event.kind === "run.tool" ? { transient: true } : {}),
        } as InferUIMessageChunk<RunUIMessage>;
        try {
            writer.write(chunk);
        } catch {
            /* Client may have disconnected. */
        }
    }

    function enqueue(task: () => Promise<void>): void {
        queue = queue.then(task).catch((error) => {
            failure ??= error;
        });
    }

    async function persistCurrent(): Promise<void> {
        if (snapshot === undefined || !snapshotDirty) return;
        lastPersistedAt = Date.now();
        try {
            await persistence.persist(snapshot);
            snapshotDirty = false;
        } catch (error) {
            // Keep draining so the latest partial output can still be persisted.
            failure ??= error;
        }
    }

    const sink: EventSink = {
        emit(event: RunEvent) {
            if (
                event.kind === "run.finished" ||
                event.kind === "run.failed" ||
                event.kind === "run.cancelled"
            )
                terminal = event;
            else writeEvent(event);
        },
        merge(stream) {
            const [toClient, toSnapshots] = stream.tee();
            writer.merge(
                toClient as ReadableStream<InferUIMessageChunk<RunUIMessage>>,
            );

            enqueue(async () => {
                const reader = readUIMessageStream<RunUIMessage>({
                    stream: toSnapshots,
                    message: snapshot ?? {
                        id: persistence.assistantMessageId,
                        role: "assistant",
                        parts: [],
                    },
                    onError: () => {
                        // The client branch already carries the error; nothing to add here.
                    },
                });

                for await (const next of reader) {
                    snapshot = next;
                    snapshotDirty = true;
                    if (Date.now() - lastPersistedAt >= SNAPSHOT_INTERVAL_MS) {
                        await persistCurrent();
                    }
                }
                await persistCurrent();
            });
        },
        setMessageMetadata(metadata: RunMessageMetadata) {
            try {
                writer.write({
                    type: "message-metadata",
                    messageMetadata: metadata,
                } as InferUIMessageChunk<RunUIMessage>);
            } catch {
                // Stream may already be closed (e.g. client disconnected); safe to ignore.
            }
            enqueue(async () => {
                if (snapshot === undefined) return;
                snapshot = {
                    ...snapshot,
                    metadata: { ...snapshot.metadata, ...metadata },
                };
                snapshotDirty = true;
                await persistCurrent();
            });
        },
    };

    return {
        sink,
        settled: async () => {
            await queue;
            if (failure !== undefined) throw failure;
        },
        finish(status) {
            if (!terminal) return;
            writeEvent(terminalEventFor(status, terminal));
            terminal = undefined;
        },
    };
}

function terminalEventFor(
    status: Exclude<RunStatus, "running">,
    terminal: RunEvent,
): RunEvent {
    if (status === "finished" && terminal.kind === "run.finished") {
        return terminal;
    }
    if (status === "cancelled") {
        return { kind: "run.cancelled", runId: terminal.runId };
    }
    return {
        kind: "run.failed",
        runId: terminal.runId,
        error:
            terminal.kind === "run.failed"
                ? terminal.error
                : "Run could not complete",
    };
}
