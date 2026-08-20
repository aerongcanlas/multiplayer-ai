"use server";

import { getCurrentUser } from "@/features/auth/server/getCurrentUser";
import { createAdminClient } from "@/lib/supabase/server";

export async function markRoomVisited(roomId: string) {
    const user = await getCurrentUser();

    if (!user) {
        return { success: false };
    }

    const supabase = createAdminClient();

    const { data, error } = await supabase
        .from("room_member")
        .update({
            last_visited_at: new Date().toISOString(),
        })
        .eq("room_id", roomId)
        .eq("member_id", user.id)
        .select("room_id")
        .maybeSingle();

    return {
        success: error === null && data !== null,
    };
}
