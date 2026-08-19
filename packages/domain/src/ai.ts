export const chatProviders = ["gemini", "openai"] as const;

export type ChatProvider = (typeof chatProviders)[number];

export function isChatProvider(value: unknown): value is ChatProvider {
    return (
        typeof value === "string" &&
        (chatProviders as readonly string[]).includes(value)
    );
}
