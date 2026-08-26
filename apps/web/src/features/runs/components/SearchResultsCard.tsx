"use client";

import { Box, Spinner, TextBox } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { RunTools } from "@multiplayer-ai/domain";
import type { ToolUIPart } from "ai";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

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
    const [open, setOpen] = useState(false);
    const query = part.input?.query;
    const results = part.state === "output-available" ? part.output.results : [];

    return (
        <Box className="m-2 rounded-xl border border-white/10 bg-[#1E1E1E] px-3 py-2.5 text-sm">
            <button
                type="button"
                className="flex w-full items-center gap-1.5 text-white/80"
                onClick={() => setOpen(!open)}
            >
                <ChevronDownIcon
                    className={cn("size-3.5 shrink-0 transition-transform", !open && "-rotate-90")}
                />
                <span className="font-medium">webSearch</span>
                {query && <span className="truncate text-white/50"> — {query}</span>}
                {part.state === "output-available" && results.length > 0 && (
                    <span className="ml-auto shrink-0 text-xs text-white/30">
                        {results.length}
                    </span>
                )}
            </button>

            {part.state === "output-error" && (
                <TextBox className="mt-1.5 text-red-400/80">{part.errorText}</TextBox>
            )}

            {part.state !== "output-available" && part.state !== "output-error" && (
                <div className="mt-1.5 flex items-center gap-2 text-white/50">
                    <Spinner className="size-3" />
                    <TextBox>Searching…</TextBox>
                </div>
            )}

            {open && part.state === "output-available" && results.length === 0 && (
                <TextBox className="mt-1.5 text-white/40">
                    No results — search unavailable.
                </TextBox>
            )}

            {open && part.state === "output-available" && results.length > 0 && (
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
