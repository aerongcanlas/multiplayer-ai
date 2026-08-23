"use client";

import { Box, BoxColumn } from "@/components/ui";
import { useChatScroll } from "@/features/rooms/hooks/useChatScroll";
import { useRoomChat } from "@/features/rooms/hooks/useRoomChat";
import type {
    RoomPageMember,
    RoomPageMessage,
} from "@/features/rooms/types/room";
import { useEffect } from "react";
import ChatMessageInput from "./ChatMessageInput";
import InviteUserModal from "./InviteUserModal";
import Messages from "./Messages";

interface Props {
    roomId: string;
    roomName: string;
    currentUserId: string;
    currentUserIsAdmin: boolean;
    initialMessages: RoomPageMessage[];
    members: RoomPageMember[];
}

function GroupChatPanel({
    roomId,
    roomName,
    currentUserId,
    currentUserIsAdmin,
    initialMessages,
    members,
}: Props) {
    const { containerRef, scrollToBottom } = useChatScroll();

    const currentAuthor =
        members.find((member) => member.member_id === currentUserId)
            ?.user_profile ?? null;

    const { messages, send, isConnected } = useRoomChat({
        roomId,
        initialMessages,
        currentAuthor,
    });

    useEffect(() => {
        scrollToBottom();
    }, [messages.length, scrollToBottom]);

    return (
        <BoxColumn className="h-full min-h-0 p-2">
            <Box className="flex items-center justify-between gap-2 px-1 m-2">
                <p>{roomName}</p>
                {currentUserIsAdmin && <InviteUserModal roomId={roomId} />}
            </Box>

            <Box
                ref={containerRef}
                className="min-h-0 flex-1 overflow-y-auto"
            >
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
