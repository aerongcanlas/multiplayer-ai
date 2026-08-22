"use client";

import { sendMessage } from "@/features/rooms/actions/sendMessage";
import { roomPageMessageSchema } from "@/features/rooms/schemas/roomPageMessageSchema";
import type {
    RoomChatMessage,
    RoomPageMessage,
    SendMessageResult,
} from "@/features/rooms/types/room";
import { createClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface Props {
    roomId: string;
    initialMessages: RoomPageMessage[];
    currentAuthor: RoomPageMessage["author"] | null;
}

const MESSAGE_EVENT = "message";

export function useRoomChat({ roomId, initialMessages, currentAuthor }: Props) {
    const supabase = useMemo(() => createClient(), []);
    const channelRef = useRef<RealtimeChannel | null>(null);

    const [messages, setMessages] =
        useState<RoomChatMessage[]>(initialMessages);
    const [isConnected, setIsConnected] = useState(false);

    const appendMessage = useCallback((message: RoomChatMessage) => {
        setMessages((current) => {
            if (current.some((item) => item.id === message.id)) {
                return current;
            }

            return [...current, message].sort((left, right) =>
                left.created_at.localeCompare(right.created_at),
            );
        });
    }, []);

    useEffect(() => {
        const channel = supabase
            .channel(`room:${roomId}:messages`)
            .on("broadcast", { event: MESSAGE_EVENT }, ({ payload }) => {
                const parsedMessage = roomPageMessageSchema.safeParse(payload);

                if (!parsedMessage.success) {
                    return;
                }

                if (parsedMessage.data.room_id !== roomId) {
                    return;
                }

                appendMessage(parsedMessage.data);
            })
            .subscribe((status) => {
                setIsConnected(status === "SUBSCRIBED");
            });

        channelRef.current = channel;

        return () => {
            channelRef.current = null;
            setIsConnected(false);
            void supabase.removeChannel(channel);
        };
    }, [appendMessage, roomId, supabase]);

    const send = useCallback(
        async (text: string): Promise<SendMessageResult> => {
            if (currentAuthor === null) {
                return {
                    success: false,
                    error: "Current user profile is missing",
                };
            }

            const optimisticId = crypto.randomUUID();

            const optimisticMessage: RoomChatMessage = {
                id: optimisticId,
                room_id: roomId,
                author_id: currentAuthor.id,
                text,
                created_at: new Date().toISOString(),
                author: currentAuthor,
                deliveryStatus: "sending",
            };

            appendMessage(optimisticMessage);

            const result = await sendMessage({
                room_id: roomId,
                text,
            });

            if (!result.success) {
                setMessages((current) =>
                    current.map((message) =>
                        message.id === optimisticId
                            ? { ...message, deliveryStatus: "failed" }
                            : message,
                    ),
                );

                return result;
            }

            // Replace temporary data with the canonical database row
            setMessages((current) =>
                [
                    ...current.filter(
                        (message) =>
                            message.id !== optimisticId &&
                            message.id !== result.message.id,
                    ),
                    result.message,
                ].sort((left, right) =>
                    left.created_at.localeCompare(right.created_at),
                ),
            );

            await channelRef.current?.send({
                type: "broadcast",
                event: MESSAGE_EVENT,
                payload: result.message,
            });

            return result;
        },
        [appendMessage, currentAuthor, roomId],
    );

    return {
        messages,
        send,
        isConnected,
    };
}
