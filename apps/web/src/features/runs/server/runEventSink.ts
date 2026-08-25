import type { RunEvent, RunMessageMetadata } from "@multiplayer-ai/domain";
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
        // Stream may already be closed (e.g. client disconnected); safe to ignore.
      }
    },
    merge(stream) {
      writer.merge(stream as ReadableStream<InferUIMessageChunk<RunUIMessage>>);
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
    },
  };
}
