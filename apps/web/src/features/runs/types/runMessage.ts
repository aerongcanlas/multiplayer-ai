import type { RunDataTypes, ScoutBrief, SearchResult } from "@multiplayer-ai/domain";
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

export type RunUIMessage = UIMessage<never, RunDataTypes, RunTools>;
