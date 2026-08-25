import type { UIMessageChunk } from "ai";
import type {
    EffortLevel,
    ModelKey,
    RunEvent,
    RunMessageMetadata,
    RunStatus,
    RunUIMessage,
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
    /** Attaches usage metadata to the assistant message currently being assembled. */
    setMessageMetadata?(metadata: RunMessageMetadata): void;
}

/** A room's durable AI panel conversation. Status reflects the outcome of the most recent run against it. */
export type ThreadRecord = {
    messages: Array<RunUIMessage>;
    status: RunStatus;
};

const EMPTY_THREAD: ThreadRecord = { messages: [], status: "finished" };

export interface RunStore {
    /** Returns an empty, finished thread for a room that has never run — never undefined. */
    load(roomId: string): Promise<ThreadRecord>;
    save(roomId: string, record: ThreadRecord): Promise<void>;
    clear(roomId: string): Promise<void>;
}

export function emptyThread(): ThreadRecord {
    return EMPTY_THREAD;
}
