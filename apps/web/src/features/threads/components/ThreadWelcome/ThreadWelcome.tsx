"use client";

import { Bot } from "lucide-react";
import { BoxColumn, TextBox } from "@/components/ui";

export function ThreadWelcome({ className }: { className?: string }) {
    return (
        <BoxColumn
            aria-label="New thread welcome"
            className={`min-h-0 flex-1 items-center justify-center gap-3 px-6 text-center ${className ?? ""}`}
        >
            <Bot aria-hidden="true" className="size-10 text-primary" />
            <h2 className="text-xl font-semibold tracking-tight">
                A shared goal. A visible plan.
            </h2>
            <TextBox className="max-w-sm text-sm text-white/60">
                Send a direction to start working together.
            </TextBox>
        </BoxColumn>
    );
}

export default ThreadWelcome;
