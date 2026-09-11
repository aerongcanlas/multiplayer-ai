import type { Database } from "@multiplayer-ai/db";
import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

/**
 * If using Fluid compute: Don't put this client in a global variable. Always create a new client within each
 * function when using it.
 */
export async function createClient() {
    const cookieStore = await cookies();

    return createServerClient<Database>(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
        {
            cookies: {
                getAll() {
                    return cookieStore.getAll();
                },
                setAll(cookiesToSet) {
                    try {
                        cookiesToSet.forEach(({ name, value, options }) =>
                            cookieStore.set(name, value, options),
                        );
                    } catch {
                        // The `setAll` method was called from a Server Component.
                        // This can be ignored if you have middleware refreshing
                        // user sessions.
                    }
                },
            },
        },
    );
}

export function parseRequestCookies(request: Request) {
    const header = request.headers.get("cookie");
    if (!header) return [];
    return header.split(/;\s*/).flatMap((entry) => {
        const separator = entry.indexOf("=");
        if (separator < 1) return [];
        const name = entry.slice(0, separator);
        const encodedValue = entry.slice(separator + 1);
        try {
            return [{ name, value: decodeURIComponent(encodedValue) }];
        } catch {
            return [{ name, value: encodedValue }];
        }
    });
}

/** Creates a request-bound client for route handlers without relying on Next's async context. */
export function createRequestClient(request: Request) {
    return createServerClient<Database>(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
        {
            cookies: {
                getAll: () => parseRequestCookies(request),
                setAll: () => {
                    // Middleware owns session refresh cookie writes.
                },
            },
        },
    );
}

export function createAdminClient() {
    return createSupabaseClient<Database>(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SECRET_KEY!,
        {
            auth: {
                autoRefreshToken: false,
                detectSessionInUrl: false,
                persistSession: false,
            },
        },
    );
}
