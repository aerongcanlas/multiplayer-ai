import { Box, Spinner, TextBox } from "@/components/ui";
import type { RunTools } from "@/features/runs/types/runMessage";
import type { ToolUIPart } from "ai";

interface Props {
    part: ToolUIPart<Pick<RunTools, "webSearch">>;
}

function hostname(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}

function SearchResultsCard({ part }: Props) {
    const query = part.input?.query;
    const results = part.state === "output-available" ? part.output.results : [];

    return (
        <Box className="m-2 rounded-xl border border-white/10 bg-[#1E1E1E] px-3 py-2.5 text-sm">
            <TextBox className="text-white/80">
                <span className="font-medium">webSearch</span>
                {query && <span className="text-white/50"> — {query}</span>}
            </TextBox>

            {part.state === "output-error" && (
                <TextBox className="mt-1.5 text-red-400/80">{part.errorText}</TextBox>
            )}

            {part.state !== "output-available" && part.state !== "output-error" && (
                <div className="mt-1.5 flex items-center gap-2 text-white/50">
                    <Spinner className="size-3" />
                    <TextBox>Searching…</TextBox>
                </div>
            )}

            {part.state === "output-available" && results.length === 0 && (
                <TextBox className="mt-1.5 text-white/40">
                    No results — search unavailable.
                </TextBox>
            )}

            {part.state === "output-available" && results.length > 0 && (
                <ul className="mt-1.5 space-y-1.5">
                    {results.map((result) => (
                        <li key={result.url}>
                            <a
                                href={result.url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-white/70 underline decoration-white/20 underline-offset-2 hover:text-white/90"
                            >
                                {result.title}
                            </a>
                            <TextBox className="text-white/30">
                                {hostname(result.url)}
                            </TextBox>
                            {result.snippet && (
                                <TextBox className="text-white/50">{result.snippet}</TextBox>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </Box>
    );
}

export default SearchResultsCard;
