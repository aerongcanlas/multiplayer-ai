"use server";

import { getCurrentUser } from "@/features/auth/server/getCurrentUser";
import { createRoomInviteToken } from "@/features/rooms/server/roomInviteToken";
import { createAdminClient } from "@/lib/supabase/server";
import {
    createRoomInviteSchema,
    type CreateRoomInviteInput,
} from "@multiplayer-ai/domain";

export type CreateRoomInviteResult =
    | { success: true; invitePath: string }
    | { success: false; error: string };

const INVITE_LIFETIME_MS = 24 * 60 * 60 * 1000;

export async function createRoomInvite(
    unsafeData: CreateRoomInviteInput,
): Promise<CreateRoomInviteResult> {
    const parsed = createRoomInviteSchema.safeParse(unsafeData);

    if (!parsed.success) {
        return { success: false, error: "Invalid room" };
    }

    const user = await getCurrentUser();
    if (user === null) {
        return { success: false, error: "User not authenticated" };
    }

    const supabase = createAdminClient();

    const { data: membership, error: membershipError } = await supabase
        .from("room_member")
        .select("member_id")
        .eq("room_id", parsed.data.roomId)
        .eq("member_id", user.id)
        .eq("is_admin", true)
        .maybeSingle();

    if (membershipError || membership === null) {
        return { success: false, error: "Only room admins can invite people" };
    }

    const { token, tokenHash } = createRoomInviteToken();
    const expiresAt = new Date(Date.now() + INVITE_LIFETIME_MS).toISOString();

    const { error: inviteError } = await supabase.from("room_invite").insert({
        room_id: parsed.data.roomId,
        created_by: user.id,
        token_hash: tokenHash,
        expires_at: expiresAt,
    });

    if (inviteError) {
        return { success: false, error: "Could not create the invitation" };
    }

    return {
        success: true,
        invitePath: `/invite/${token}`,
    };
}
