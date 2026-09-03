"use client";

import { Box, BoxColumn, Button } from "@/components/ui";
import { suggestPromptsFromMessages } from "@/features/rooms/actions/suggestPromptsFromMessages";
import { useChatScroll } from "@/features/rooms/hooks/useChatScroll";
import { useRoomChat } from "@/features/rooms/hooks/useRoomChat";
import type {
    RoomPageMember,
    RoomPageMessage,
} from "@/features/rooms/types/room";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePromptSuggestions } from "./PromptSuggestionProvider";
import ChatMessageInput from "./room-chat/ChatMessageInput";
import InviteUserModal from "./room-chat/InviteUserModal";
import Messages from "./room-chat/Messages";

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
    const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(
        () => new Set(),
    );
    const { containerRef, scrollToBottom } = useChatScroll();
    const {
        isGenerating,
        beginGeneration,
        completeGeneration,
        failGeneration,
    } = usePromptSuggestions();

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

    const setMessageSelected = useCallback(
        (messageId: string, selected: boolean) => {
            setSelectedMessageIds((current) => {
                const next = new Set(current);

                if (selected) {
                    next.add(messageId);
                } else {
                    next.delete(messageId);
                }

                return next;
            });
        },
        [],
    );

    const selectedMessagePayload = useMemo(
        () =>
            messages.flatMap((message) =>
                message.deliveryStatus === undefined &&
                selectedMessageIds.has(message.id)
                    ? [
                          {
                              messageId: message.id,
                              content: message.text,
                          },
                      ]
                    : [],
            ),
        [messages, selectedMessageIds],
    );

    const clearSelectedMessages = useCallback(() => {
        setSelectedMessageIds(new Set());
    }, []);

    const generatePromptSuggestions = useCallback(async () => {
        const messageIds = selectedMessagePayload.map(
            (message) => message.messageId,
        );
        if (messageIds.length === 0 || isGenerating) return;

        beginGeneration();

        try {
            const result = await suggestPromptsFromMessages({
                roomId,
                messageIds,
            });

            if (!result.success) {
                failGeneration(result.error);
                return;
            }

            completeGeneration(result.suggestion);
        } catch {
            failGeneration("Could not generate prompt suggestions");
        }
    }, [
        selectedMessagePayload,
        isGenerating,
        beginGeneration,
        roomId,
        failGeneration,
        completeGeneration,
    ]);

    return (
        <BoxColumn className="h-full min-h-0 p-2">
            <Box className="m-2 grid grid-cols-[1fr_auto_1fr] items-center px-1">
                <p className="col-start-2 row-start-1 text-lg font-semibold">
                    {roomName}
                </p>
                {currentUserIsAdmin && (
                    <div className="col-start-3 row-start-1 justify-self-end">
                        <InviteUserModal roomId={roomId} />
                    </div>
                )}
            </Box>

            <Box
                ref={containerRef}
                className="min-h-0 flex-1 overflow-y-auto"
            >
                <Messages
                    currentUserId={currentUserId}
                    messages={messages}
                    selectedMessageIds={selectedMessageIds}
                    onMessageSelect={setMessageSelected}
                />
            </Box>

            {selectedMessagePayload.length > 0 && (
                <Box className="flex shrink-0 items-center justify-between gap-2 px-2 py-1">
                    <p
                        aria-live="polite"
                        className="text-xs text-muted-foreground"
                    >
                        {selectedMessagePayload.length}{" "}
                        {selectedMessagePayload.length === 1
                            ? "message selected"
                            : "messages selected"}
                    </p>
                    <div className="flex items-center gap-1">
                        <Button
                            disabled={isGenerating}
                            size="xs"
                            type="button"
                            onClick={() => void generatePromptSuggestions()}
                        >
                            {isGenerating
                                ? "Summarizing..."
                                : "Suggest prompts"}
                        </Button>
                        <Button
                            size="xs"
                            type="button"
                            variant="ghost"
                            onClick={clearSelectedMessages}
                        >
                            Clear
                        </Button>
                    </div>
                </Box>
            )}

            <ChatMessageInput
                disabled={!isConnected}
                onSend={send}
            />
        </BoxColumn>
    );
}
export default GroupChatPanel;
