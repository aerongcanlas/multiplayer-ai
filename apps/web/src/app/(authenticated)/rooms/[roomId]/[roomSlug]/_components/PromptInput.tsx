"use client";

import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { SubmitEvent } from "react";

interface Props {
    className?: string;
    disabled?: boolean;
    placeholder?: string;
    value: string;
    onValueChange: (value: string) => void;
    onSubmit: (text: string) => Promise<void> | void;
}

function PromptInput({
    onSubmit,
    onValueChange,
    value,
    className,
    disabled = false,
    placeholder = "Message the room",
}: Props) {
    async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
        event.preventDefault();

        const nextText = value.trim();
        if (disabled || nextText.length === 0) return;

        onValueChange("");

        try {
            await onSubmit(nextText);
        } catch {
            onValueChange(nextText);
        }
    }

    return (
        <form
            className={cn(
                "flex w-full items-center gap-2 rounded-2xl bg-[#2A2A2A] p-2",
                className,
            )}
            onSubmit={handleSubmit}
        >
            <Input
                aria-label="Message"
                disabled={disabled}
                maxLength={2_000}
                placeholder={placeholder}
                value={value}
                onChange={(event) => onValueChange(event.target.value)}
            />
            <Button
                disabled={disabled || value.trim().length === 0}
                type="submit"
            >
                Send
            </Button>
        </form>
    );
}

export default PromptInput;
