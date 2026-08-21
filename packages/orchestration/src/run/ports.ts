import type { ModelMessage, UIMessageChunk } from "ai";
import type {
    EffortLevel,
    ModelKey,
    RunEvent,
    RunStatus,
} from "@multiplayer-ai/domain";

export type RunInput = {
    runId: string;
    roomId: string;
    goal: string;
    model: ModelKey;
    effort?: EffortLevel;
};

export interface EventSink {
    emit(event: RunEvent): void | Promise<void>;
    merge?(stream: ReadableStream<UIMessageChunk>): void;
}

export type RunRecord = {
    input: RunInput;
    messages: Array<ModelMessage>;
    status: RunStatus;
};

export interface RunStore {
    load(runId: string): Promise<RunRecord | undefined>;
    save(record: RunRecord): Promise<void>;
}
