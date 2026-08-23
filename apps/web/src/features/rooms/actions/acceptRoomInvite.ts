"use server";

import { getCurrentUser } from "@/features/auth/server/getCurrentUser";
import { hashRoomInviteToken } from "@/features/rooms/server/roomInviteToken";
import { createAdminClient } from "@/lib/supabase/server";
import {
    acceptRoomInviteSchema,
    type AcceptRoomInviteInput,
} from "@multiplayer-ai/domain";
import { redirect } from "next/navigation";

export async function acceptRoomInvite(unsafeData: AcceptRoomInviteInput) {
    const parsed = acceptRoomInviteSchema.safeParse(unsafeData);

    if (!parsed.success) {
        redirect("/");
    }

    const token = parsed.data.token;
    const invitePath = `/invite/${token}`;
    const user = await getCurrentUser();

    if (user === null) {
        redirect(`/auth/login?next=${encodeURIComponent(invitePath)}`);
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase
        .rpc("accept_room_invite", {
            p_token_hash: hashRoomInviteToken(token),
            p_user_id: user.id,
        })
        .single();

    if (error) {
        redirect(`${invitePath}?error=server`);
    }

    if (
        data.status !== "accepted" ||
        data.accepted_room_id === null ||
        data.accepted_room_slug === null
    ) {
        redirect(`${invitePath}?error=invalid`);
    }

    redirect(`/rooms/${data.accepted_room_id}/${data.accepted_room_slug}`);
}
