'use client';

import { Box } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useState, type KeyboardEvent } from 'react';

interface Props {
    className?: string;
    disabled?: boolean;
    onSubmit?: (text: string) => void;
}

function TextEntryBubble({ onSubmit, className, disabled = false }: Props) {
    const [value, setValue] = useState('');

    function submit() {
        const text = value.trim();
        if (disabled || !text || !onSubmit) return;
        onSubmit(text);
        setValue('');
    }

    function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        submit();
    }

    return (
        <Box className={cn('bg-[#2A2A2A] p-2 m-2 w-full', className)}>
            <textarea
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder='Type a message...'
                className='h-full w-full resize-none bg-transparent outline-none'
            />
        </Box>
    );
}
export default TextEntryBubble;
