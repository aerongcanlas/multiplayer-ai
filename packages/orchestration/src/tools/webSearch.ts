import { tool } from "ai";
import { z } from "zod";
import { traced, type ToolDeps } from "./shared";

export function createWebSearchTool(deps: ToolDeps) {
    return tool({
        description: "Search the web. Returns titles, urls and snippets.",
        inputSchema: z.object({ query: z.string() }),
        execute: traced(deps, "webSearch", async ({ query }, { abortSignal }) => ({
            results: await deps.search(query, {
                maxResults: deps.profile.searchMaxResults,
                searchDepth: deps.profile.searchDepth,
                abortSignal,
            }),
        })),
    });
}
