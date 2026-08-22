import { createAdminClient } from "@/lib/supabase/server";
import type { Database } from "@multiplayer-ai/db";
import type { SupabaseClient } from "@supabase/supabase-js";

type DatabaseClient = SupabaseClient<Database>;

async function getRoom(
    supabase: DatabaseClient,
    roomId: string,
    userId: string,
) {
    return supabase
        .from("room_member")
        .select(
            `
            is_admin,
            room:room!room_member_room_id_fkey (
                id,
                name,
                slug,
                created_at
            )
        `,
        )
        .eq("room_id", roomId)
        .eq("member_id", userId)
        .maybeSingle();
}

async function getRoomMembers(supabase: DatabaseClient, roomId: string) {
    return supabase
        .from("room_member")
        .select(
            `
            member_id,
            is_admin,
            user_profile:user_profile!room_member_member_id_fkey (
                id,
                name,
                image_url
            )
        `,
        )
        .eq("room_id", roomId);
}

async function getRoomMessages(supabase: DatabaseClient, roomId: string) {
    return supabase
        .from("message")
        .select(
            `
            *,
            author:user_profile!message_author_id_fkey (
                id,
                name,
                image_url
            )
            `,
        )
        .eq("room_id", roomId)
        .order("created_at", { ascending: false })
        .limit(50);
}

export async function getRoomPageData(roomId: string, userId: string) {
    const supabase = await createAdminClient();

    const roomData = await getRoom(supabase, roomId, userId);

    if (roomData.error) {
        throw roomData.error;
    }

    if (!roomData.data?.room) {
        return null;
    }

    const [membersResult, messagesResult] = await Promise.all([
        getRoomMembers(supabase, roomId),
        getRoomMessages(supabase, roomId),
    ]);

    if (membersResult.error) {
        throw membersResult.error;
    }

    if (messagesResult.error) {
        throw messagesResult.error;
    }

    return {
        room: roomData.data.room,
        currentMembership: {
            isAdmin: roomData.data.is_admin,
        },
        members: membersResult.data,
        messages: [...messagesResult.data].reverse(),
    };
}
