"use server";
import z from "zod";

import { getCurrentUser } from "@/lib/supabase/getCurrentUser";
import { createAdminClient } from "@/lib/supabase/server";
import { createRoomSchema } from "@/schemas/rooms";
import slugify from "@sindresorhus/slugify";
import { redirect } from "next/navigation";

export async function createRoom(unsafeData: z.infer<typeof createRoomSchema>) {
    const { success, data } = createRoomSchema.safeParse(unsafeData);

    if (!success) {
        return { error: true, message: "Invalid room data" };
    }

    const roomNameSlug = slugify(data.name);

    const user = await getCurrentUser();
    if (user === null) {
        return { error: true, message: "User not authenticated" };
    }

    const supabase = await createAdminClient();

    const { data: room, error: roomError } = await supabase
        .from("room")
        .insert({ name: data.name, slug: roomNameSlug })
        .select("id")
        .single();

    if (roomError || room === null) {
        return { error: true, message: "Failed to create room" };
    }

    const { error: membershipError } = await supabase
        .from("room_member")
        .insert({ room_id: room.id, member_id: user.id, is_admin: true });

    if (membershipError) {
        return { error: true, message: "Failed to add user to room" };
    }

    redirect(`/rooms/${room.id}/${roomNameSlug}`);
}
