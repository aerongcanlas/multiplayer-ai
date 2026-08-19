import { BoxColumn } from '@/components/ui';
import type { Message } from '../../types/message';
import ChatMessageBubble from './ChatMessageBubble';

interface Props {
    currentUserId?: string;
    messages: Array<Pick<Message, 'id' | 'userId' | 'text'>>;
}

function Messages({ messages, currentUserId }: Props) {
    return (
        <BoxColumn>
            {messages.map((message) => (
                <ChatMessageBubble
                    key={message.id}
                    message={message}
                    className={
                        message.userId === currentUserId
                            ? 'self-end'
                            : 'self-start'
                    }
                />
            ))}
        </BoxColumn>
    );
}

export default Messages;
