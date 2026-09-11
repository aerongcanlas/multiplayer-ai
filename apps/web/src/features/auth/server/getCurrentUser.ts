import { createClient, createRequestClient } from "@/lib/supabase/server";

export async function getCurrentUser(request?: Request) {
    const supabase = request ? createRequestClient(request) : await createClient();

    return (await supabase.auth.getUser()).data.user;
}
