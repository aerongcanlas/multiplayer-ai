import { createClient } from "./server";

export async function getCurrentUser() {
    const supabase = await createClient();

    return (await supabase.auth.getUser()).data.user;
}
