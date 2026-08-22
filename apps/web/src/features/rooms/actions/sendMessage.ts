"use server";

import { getCurrentUser } from "@/features/auth/server/getCurrentUser";
import type { SendMessageResult } from "@/features/rooms/types/room";
import { createAdminClient } from "@/lib/supabase/server";
import {
    createMessageSchema,
    type CreateMessageInput,
} from "@multiplayer-ai/domain";
import { roomPageMessageSchema } from "../schemas/roomPageMessageSchema";

export async function sendMessage(
    unsafeData: CreateMessageInput,
): Promise<SendMessageResult> {
    const { success, data } = createMessageSchema.safeParse(unsafeData);

    if (!success) {
        return { success: false, error: "Invalid message data" };
    }

    const user = await getCurrentUser();
    if (user === null) {
        return { success: false, error: "User not authenticated" };
    }

    const supabase = await createAdminClient();

    const { data: membership, error: membershipError } = await supabase
        .from("room_member")
        .select("member_id")
        .eq("member_id", user.id)
        .eq("room_id", data.room_id)
        .maybeSingle();

    if (membershipError || membership === null) {
        return { success: false, error: "User is not a member" };
    }

    const { data: message, error: messageError } = await supabase
        .from("message")
        .insert({
            room_id: data.room_id,
            text: data.text,
            author_id: user.id,
        })
        .select(
            `
            id,
            room_id,
            author_id,
            text,
            created_at,
            author:user_profile!message_author_id_fkey (
                id,
                name,
                image_url
            )
        `,
        )
        .single();

    if (messageError || message === null) {
        return { success: false, error: "Failed to send message" };
    }

    const parsedMessage = roomPageMessageSchema.safeParse(message);

    if (!parsedMessage.success) {
        return {
            success: false,
            error: "Failed to send message",
        };
    }

    return { success: true, message: parsedMessage.data };
}
