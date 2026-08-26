import type {
        RunEvent,
        RunMessageMetadata,
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
};

export function createRunEventSink(
    writer: UIMessageStreamWriter<RunUIMessage>,
    persistence: SnapshotPersistence,
): RunEventSink {
    let snapshot: RunUIMessage | undefined;
    let lastPersistedAt = 0;
    let queue: Promise<void> = Promise.resolve();

    function enqueue(task: () => Promise<void>): void {
        queue = queue.then(task).catch((error) => {
            console.error("[run snapshot]", error);
        });
    }

    async function persistCurrent(): Promise<void> {
        if (snapshot === undefined) return;
        lastPersistedAt = Date.now();
        await persistence.persist(snapshot);
    }

    const sink: EventSink = {
        emit(event: RunEvent) {
            const chunk = {
                type: `data-${event.kind}`,
                data: event,
                ...(event.kind === "run.tool" ? { transient: true } : {}),
            } as InferUIMessageChunk<RunUIMessage>;
            try {
                writer.write(chunk);
            } catch {
                // Stream may already be closed (e.g. client disconnected); safe to ignore.
            }
        },
        merge(stream) {
            const [toClient, toSnapshots] = stream.tee();
            writer.merge(toClient as ReadableStream<InferUIMessageChunk<RunUIMessage>>);

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
                snapshot = { ...snapshot, metadata: { ...snapshot.metadata, ...metadata } };
                await persistCurrent();
            });
        },
    };

    return { sink, settled: () => queue };
}
