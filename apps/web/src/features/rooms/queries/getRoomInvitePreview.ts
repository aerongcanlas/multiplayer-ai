import { hashRoomInviteToken } from "@/features/rooms/server/roomInviteToken";
import { createAdminClient } from "@/lib/supabase/server";
import { acceptRoomInviteSchema } from "@multiplayer-ai/domain";

export async function getRoomInvitePreview(token: string) {
    const parsed = acceptRoomInviteSchema.safeParse({ token });
    if (!parsed.success) {
        return null;
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase
        .from("room_invite")
        .select(
            `
            room:room!room_invite_room_id_fkey (
                id,
                name,
                slug
            )
        `,
        )
        .eq("token_hash", hashRoomInviteToken(parsed.data.token))
        .is("accepted_at", null)
        .is("revoked_at", null)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();

    if (error) {
        throw error;
    }

    return data?.room ?? null;
}
