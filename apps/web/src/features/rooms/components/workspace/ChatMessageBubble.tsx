import { Box, TextBox } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { Message } from '@multiplayer-ai/domain';

interface Props {
    className?: string;
    message: Pick<Message, 'text'>;
}
function ChatMessageBubble({ className, message }: Props) {
    return (
        <Box
            className={cn(
                'bg-[#242424] pt-2 pb-2.5 px-4 m-2 w-fit rounded-xl wrap-break-word',
                className,
            )}
        >
            <TextBox>{message.text}</TextBox>
        </Box>
    );
}
export default ChatMessageBubble;
