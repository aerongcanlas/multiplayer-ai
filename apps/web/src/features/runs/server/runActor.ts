import type { RunMessageAuthor } from "@multiplayer-ai/domain";
import type { User } from "@supabase/supabase-js";
import { getCurrentUser } from "@/features/auth/server/getCurrentUser";
import { runRuntime } from "@/features/runs/server/runRuntime";

function fallbackName(user: User): string {
    const claimed = user.user_metadata?.name;
    if (typeof claimed === "string" && claimed.length > 0) return claimed;
    return user.email ?? "Member";
}

export function toRunActor(
    user: User,
    profile: RunMessageAuthor | null,
): RunMessageAuthor {
    return profile ?? { id: user.id, name: fallbackName(user) };
}

export async function getRunActor(): Promise<RunMessageAuthor | null> {
    const user = await getCurrentUser();
    if (user === null) return null;
    return toRunActor(user, await runRuntime.profile(user));
}
