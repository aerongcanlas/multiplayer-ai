"use client";

import { Box, BoxColumn } from "@/components/ui";
import { useRoomChat } from "@/features/rooms/hooks/useRoomChat";
import type {
    RoomPageMember,
    RoomPageMessage,
} from "@/features/rooms/types/room";
import ChatMessageInput from "./ChatMessageInput";
import Messages from "./Messages";

interface Props {
    roomId: string;
    roomName: string;
    currentUserId: string;
    initialMessages: RoomPageMessage[];
    members: RoomPageMember[];
}

function GroupChatPanel({
    roomId,
    roomName,
    currentUserId,
    initialMessages,
    members,
}: Props) {
    const { messages, send, isConnected } = useRoomChat({
        roomId,
        initialMessages,
    });

    messages.concat([messages[0]]);

    return (
        <BoxColumn className="h-full min-h-0 p-2">
            <p>{roomName}</p>

            <Box className="min-h-0 flex-1 overflow-y-auto">
                <Messages
                    currentUserId={currentUserId}
                    messages={messages}
                />
            </Box>

            <ChatMessageInput
                disabled={!isConnected}
                onSend={send}
            />
        </BoxColumn>
    );
}
export default GroupChatPanel;
