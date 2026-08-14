import { BoxColumn } from '@/components/ui';
import type { Message } from '../_types/message';
import ChatMessageBubble from './ChatMessageBubble';

interface Props {
    messages: Array<Message>;
}

function Messages({ messages }: Props) {
    const userId: number = 1;

    return (
        <BoxColumn>
            {messages.map((message, index) => (
                <ChatMessageBubble
                    key={index}
                    message={message}
                    className={
                        message.userId === userId ? 'self-end' : 'self-start'
                    }
                />
            ))}
        </BoxColumn>
    );
}
export default Messages;
