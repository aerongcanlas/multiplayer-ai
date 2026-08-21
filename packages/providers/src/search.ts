import type { SearchFn } from "@multiplayer-ai/domain";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

type TavilyResult = {
    title?: string;
    url?: string;
    content?: string;
};

type TavilyResponse = {
    results?: Array<TavilyResult>;
};

export const tavilySearch: SearchFn = async (query, options) => {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) return [];

    const response = await fetch(TAVILY_ENDPOINT, {
        method: "POST",
        headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
        },
        body: JSON.stringify({
            query,
            max_results: options.maxResults,
            search_depth: options.searchDepth,
        }),
        signal: options.abortSignal,
    });

    if (!response.ok) {
        throw new Error(
            `Tavily search failed: ${response.status} ${response.statusText}`,
        );
    }

    const data = (await response.json()) as TavilyResponse;
    return (data.results ?? [])
        .filter(
            (result): result is Required<TavilyResult> =>
                typeof result.title === "string" && typeof result.url === "string",
        )
        .map((result) => ({
            title: result.title,
            url: result.url,
            snippet: result.content ?? "",
        }));
};
