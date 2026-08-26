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

export type RunMessageAuthor = {
    id: string;
    name: string;
};

export type RunUsageMetadata = {
    inputTokens: number;
    model: ModelKey;
};

export type RunMessageMetadata = {
    author?: RunMessageAuthor;
    usage?: RunUsageMetadata;
};

export type RunUIMessage = UIMessage<RunMessageMetadata, RunDataTypes, RunTools>;
