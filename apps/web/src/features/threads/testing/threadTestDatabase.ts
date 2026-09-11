export type ThreadTestDatabaseConfig = {
    url: string;
    serviceKey: string;
    anonKey: string;
};

export function threadTestDatabaseConfig(): ThreadTestDatabaseConfig | null {
    const url = process.env.THREAD_TEST_SUPABASE_URL;
    const serviceKey = process.env.THREAD_TEST_SERVICE_ROLE_KEY;
    const anonKey = process.env.THREAD_TEST_ANON_KEY;
    const supplied = [url, serviceKey, anonKey].filter(Boolean).length;

    if (supplied === 0) return null;
    if (supplied !== 3) {
        throw new Error(
            "Thread integration tests require THREAD_TEST_SUPABASE_URL, " +
                "THREAD_TEST_SERVICE_ROLE_KEY, and THREAD_TEST_ANON_KEY together.",
        );
    }
    if (process.env.NODE_ENV === "production") {
        throw new Error("Thread integration tests refuse NODE_ENV=production.");
    }

    const parsed = new URL(url!);
    const local =
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "::1";
    const configuredApplicationTarget = [
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_URL,
    ].includes(url);
    if (
        !local &&
        (configuredApplicationTarget ||
            process.env.THREAD_TEST_DATABASE_IS_DISPOSABLE !== "true")
    ) {
        throw new Error(
            "Refusing a non-local or application Supabase target. Use a disposable database " +
                "and set THREAD_TEST_DATABASE_IS_DISPOSABLE=true.",
        );
    }

    return { url: url!, serviceKey: serviceKey!, anonKey: anonKey! };
}
