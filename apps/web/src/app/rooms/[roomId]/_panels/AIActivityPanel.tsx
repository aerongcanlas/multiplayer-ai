'use client';

import { Box, BoxColumn, TextBox } from '@/components/ui';
import { useChat } from '@ai-sdk/react';
import { useEffect, useRef } from 'react';
import Messages from '../_components/Messages';
import TextEntryBubble from '../_components/TextEntryBubble';
import type { Message } from '../_types/message';

const USER_ID = 'user';
const ASSISTANT_ID = 'assistant';

function AIActivityPanel() {
    const { messages: chatMessages, sendMessage, status } = useChat();
    const scrollRef = useRef<HTMLDivElement>(null);

    const messages: Array<Pick<Message, 'id' | 'userId' | 'text'>> =
        chatMessages.map((chatMessage) => ({
            id: chatMessage.id,
            userId: chatMessage.role === 'user' ? USER_ID : ASSISTANT_ID,
            text: chatMessage.parts
                .map((part) => (part.type === 'text' ? part.text : ''))
                .join(''),
        }));

    const streamedLength = messages.reduce(
        (total, message) => total + message.text.length,
        0,
    );

    useEffect(() => {
        const node = scrollRef.current;
        if (!node) return;
        node.scrollTop = node.scrollHeight;
    }, [streamedLength]);

    return (
        <BoxColumn className='h-full min-h-0 p-2'>
            <TextBox className='shrink-0'>AIActivityPanel</TextBox>
            <Box
                ref={scrollRef}
                className='min-h-0 flex-1 overflow-y-auto'
            >
                <Messages
                    messages={messages}
                    currentUserId={USER_ID}
                />
            </Box>
            <TextEntryBubble
                className='m-2 mt-2 rounded-2xl shrink-0 h-20'
                disabled={status !== 'ready'}
                onSubmit={(text) => sendMessage({ text })}
            />
        </BoxColumn>
    );
}
export default AIActivityPanel;
