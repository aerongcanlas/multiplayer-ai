import {
    Avatar,
    AvatarFallback,
    AvatarImage,
    Box,
    BoxColumn,
    Bubble,
    BubbleContent,
    Checkbox,
    Message,
    MessageAvatar,
    MessageContent,
    MessageFooter,
} from "@/components/ui";
import type { RoomChatMessage } from "@/features/rooms/types/room";
import { cn } from "@/lib/utils";

interface Props {
    currentUserId: string;
    messages: RoomChatMessage[];
    selectedMessageIds: ReadonlySet<string>;
    onMessageSelect: (messageId: string, selected: boolean) => void;
}

function Messages({
    messages,
    currentUserId,
    selectedMessageIds,
    onMessageSelect,
}: Props) {
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
                            <Box
                                className={cn(
                                    "flex w-full items-center gap-2",
                                    message.author_id === currentUserId &&
                                        "flex-row-reverse",
                                )}
                            >
                                <Bubble
                                    variant={
                                        message.author_id === currentUserId
                                            ? "own"
                                            : "other"
                                    }
                                >
                                    <BubbleContent>
                                        {message.text}
                                    </BubbleContent>
                                </Bubble>
                                <Checkbox
                                    aria-label={`Select message from ${message.author.name}`}
                                    className="rounded-full cursor-pointer"
                                    checked={selectedMessageIds.has(message.id)}
                                    disabled={
                                        message.deliveryStatus !== undefined
                                    }
                                    onCheckedChange={(checked) =>
                                        onMessageSelect(message.id, checked)
                                    }
                                />
                            </Box>
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
