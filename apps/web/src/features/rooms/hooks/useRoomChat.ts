"use client";

import { sendMessage } from "@/features/rooms/actions/sendMessage";
import { roomPageMessageSchema } from "@/features/rooms/schemas/roomPageMessageSchema";
import type {
    RoomPageMessage,
    SendMessageResult,
} from "@/features/rooms/types/room";
import { createClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface Props {
    roomId: string;
    initialMessages: RoomPageMessage[];
}

const MESSAGE_EVENT = "message";

export function useRoomChat({ roomId, initialMessages }: Props) {
    const supabase = useMemo(() => createClient(), []);
    const channelRef = useRef<RealtimeChannel | null>(null);

    const [messages, setMessages] =
        useState<RoomPageMessage[]>(initialMessages);
    const [isConnected, setIsConnected] = useState(false);

    const appendMessage = useCallback((message: RoomPageMessage) => {
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
            const result = await sendMessage({
                room_id: roomId,
                text,
            });

            if (result.success === false) {
                return result;
            }

            appendMessage(result.message);

            await channelRef.current?.send({
                type: "broadcast",
                event: MESSAGE_EVENT,
                payload: result.message,
            });

            return result;
        },
        [appendMessage, roomId],
    );

    return {
        messages,
        send,
        isConnected,
    };
}
