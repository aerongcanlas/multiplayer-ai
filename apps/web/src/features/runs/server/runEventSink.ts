import type { RunEvent } from "@multiplayer-ai/domain";
import type { EventSink } from "@multiplayer-ai/orchestration";
import type { InferUIMessageChunk, UIMessageStreamWriter } from "ai";
import type { RunUIMessage } from "@/features/runs/types/runMessage";

export function createRunEventSink(
    writer: UIMessageStreamWriter<RunUIMessage>,
): EventSink {
    return {
        emit(event: RunEvent) {
            const chunk = {
                type: `data-${event.kind}`,
                data: event,
                ...(event.kind === "run.tool" ? { transient: true } : {}),
            } as InferUIMessageChunk<RunUIMessage>;
            try {
                writer.write(chunk);
            } catch {
            }
        },
        merge(stream) {

            writer.merge(stream as ReadableStream<InferUIMessageChunk<RunUIMessage>>);
        },
    };
}
