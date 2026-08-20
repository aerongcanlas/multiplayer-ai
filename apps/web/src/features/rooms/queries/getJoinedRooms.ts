import type { JoinedRoom } from "@/features/rooms/types/room";
import { createAdminClient } from "@/lib/supabase/server";
import { cache } from "react";

async function queryJoinedRooms(userId: string): Promise<JoinedRoom[]> {
    const supabase = createAdminClient();

    const { data, error } = await supabase
        .from("room_member")
        .select(
            `
            last_visited_at,
            room (
                id,
                name,
                slug,
                created_at,
                room_member (member_id)
            )
        `,
        )
        .eq("member_id", userId)
        .order("last_visited_at", { ascending: false });

    if (error) {
        return [];
    }

    return data.flatMap((membership) => {
        const room = membership.room;

        if (!room) {
            return [];
        }

        return [
            {
                id: room.id,
                name: room.name,
                slug: room.slug,
                created_at: room.created_at,
                member_count: room.room_member.length,
                last_visited_at: membership.last_visited_at,
            },
        ];
    });
}

const getJoinedRoomsCached = cache(queryJoinedRooms);

export function getJoinedRooms(userId: string): Promise<JoinedRoom[]> {
    return getJoinedRoomsCached(userId);
}
