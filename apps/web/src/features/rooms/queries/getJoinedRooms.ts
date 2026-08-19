import type { JoinedRoom } from "@/features/rooms/types/room";
import { createAdminClient } from "@/lib/supabase/server";

export async function getJoinedRooms(userId: string): Promise<JoinedRoom[]> {
    const supabase = createAdminClient();

    const { data, error } = await supabase
        .from("room")
        .select("*, room_member (member_id)")
        .order("created_at", { ascending: true });

    if (error) {
        return [];
    }

    return data
        .filter((room) =>
            room.room_member.some((user) => user.member_id === userId),
        )
        .map((room) => ({
            id: room.id,
            name: room.name,
            slug: room.slug,
            created_at: room.created_at,
            memberCount: room.room_member.length,
        }));
}
