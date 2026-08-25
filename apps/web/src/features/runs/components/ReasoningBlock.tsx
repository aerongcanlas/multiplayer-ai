"use client";

import { Box, Markdown } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { ReasoningUIPart } from "ai";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

interface Props {
    part: ReasoningUIPart;
}

function ReasoningBlock({ part }: Props) {
    const [userToggled, setUserToggled] = useState<boolean | null>(null);
    const streaming = part.state === "streaming";
    const open = userToggled ?? false;

    if (!part.text) return null;

    return (
        <Box className="m-2 rounded-xl border border-white/10 bg-[#1E1E1E] px-3 py-2 text-sm">
            <button
                type="button"
                className="flex w-full items-center gap-1.5 text-white/60"
                onClick={() => setUserToggled(!open)}
            >
                <ChevronDownIcon
                    className={cn(
                        "size-3.5 transition-transform",
                        !open && "-rotate-90",
                    )}
                />
                <span>{streaming ? "Thinking…" : "Thought"}</span>
            </button>
            {open && (
                <Markdown className="mt-1.5 text-xs text-white/50" isAnimating={streaming}>
                    {part.text}
                </Markdown>
            )}
        </Box>
    );
}

export default ReasoningBlock;
