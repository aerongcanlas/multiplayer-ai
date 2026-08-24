import {
    Avatar,
    AvatarFallback,
    AvatarImage,
    BoxColumn,
    Bubble,
    BubbleContent,
    Message,
    MessageAvatar,
    MessageContent,
    MessageFooter,
} from "@/components/ui";
import type { RoomChatMessage } from "@/features/rooms/types/room";

interface Props {
    currentUserId: string;
    messages: RoomChatMessage[];
}

function Messages({ messages, currentUserId }: Props) {
    return (
        <BoxColumn>
            {messages &&
                messages.length > 0 &&
                messages.map((message) => (
                    <Message
                        key={message.id}
                        align={
                            message.author_id === currentUserId
                                ? "end"
                                : "start"
                        }
                        className="py-1"
                    >
                        <MessageAvatar>
                            <Avatar>
                                <AvatarImage
                                    src={message.author.image_url ?? undefined}
                                    alt="@shadcn"
                                />
                                <AvatarFallback>
                                    {message.author.name[0]}
                                </AvatarFallback>
                            </Avatar>
                        </MessageAvatar>
                        <MessageContent>
                            <Bubble
                                variant={
                                    message.author_id === currentUserId
                                        ? "own"
                                        : "other"
                                }
                            >
                                <BubbleContent>{message.text}</BubbleContent>
                            </Bubble>
                            {message.deliveryStatus === "sending" && (
                                <MessageFooter>
                                    <span
                                        role="status"
                                        className="text-muted-foreground"
                                    >
                                        Sending...
                                    </span>
                                </MessageFooter>
                            )}

                            {message.deliveryStatus === "failed" && (
                                <MessageFooter>
                                    <span
                                        role="alert"
                                        className="text-destructive"
                                    >
                                        Failed to send
                                    </span>
                                </MessageFooter>
                            )}
                        </MessageContent>
                    </Message>
                ))}
        </BoxColumn>
    );
}

export default Messages;
