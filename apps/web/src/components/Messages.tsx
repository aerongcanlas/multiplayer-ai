import {
    Avatar,
    AvatarFallback,
    AvatarImage,
    BoxColumn,
    Bubble,
    BubbleContent,
    MessageAvatar,
    MessageContent,
} from "@/components/ui";
import type { RoomPageMessage } from "@/features/rooms/types/room";
import { Message } from "./ui";

interface Props {
    currentUserId: string;
    messages: RoomPageMessage[];
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
                        </MessageContent>
                    </Message>
                ))}
        </BoxColumn>
    );
}

export default Messages;
