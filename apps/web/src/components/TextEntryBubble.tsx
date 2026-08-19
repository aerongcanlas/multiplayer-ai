'use client';

import { Button, Input } from '@/components/ui';
import { cn } from '@/lib/utils';
import { type SubmitEvent, useState } from 'react';

interface Props {
    className?: string;
    disabled?: boolean;
    placeholder?: string;
    onSubmit: (text: string) => Promise<void> | void;
}

function TextEntryBubble({
    onSubmit,
    className,
    disabled = false,
    placeholder = 'Message the room',
}: Props) {
    const [text, setText] = useState('');

    async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
        event.preventDefault();

        const nextText = text.trim();
        if (disabled || nextText.length === 0) return;

        setText('');

        try {
            await onSubmit(nextText);
        } catch {
            setText(nextText);
        }
    }

    return (
        <form
            className={cn(
                'flex w-full items-center gap-2 rounded-2xl bg-[#2A2A2A] p-2',
                className,
            )}
            onSubmit={handleSubmit}
        >
            <Input
                aria-label='Message'
                disabled={disabled}
                maxLength={2_000}
                placeholder={placeholder}
                value={text}
                onChange={(event) => setText(event.target.value)}
            />
            <Button
                disabled={disabled || text.trim().length === 0}
                type='submit'
            >
                Send
            </Button>
        </form>
    );
}

export default TextEntryBubble;
