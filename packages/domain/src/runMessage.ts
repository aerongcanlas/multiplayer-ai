import type { ModelKey, RunDataTypes, ScoutBrief, SearchResult } from "./runs";
import type { UIMessage } from "ai";

export type RunTools = {
    webSearch: {
        input: { query: string };
        output: { results: Array<SearchResult> };
    };
    delegate: {
        input: { task: string };
        output: ScoutBrief;
    };
};

/** Recorded on an assistant message once its call completes. Absent on user messages and on assistant messages from mock mode. */
export type RunMessageMetadata = {
    inputTokens: number;
    model: ModelKey;
};

export type RunUIMessage = UIMessage<RunMessageMetadata, RunDataTypes, RunTools>;
