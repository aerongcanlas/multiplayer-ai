import { z } from "zod";

export const threadTitleSources = ["default", "auto", "manual"] as const;
export type ThreadTitleSource = (typeof threadTitleSources)[number];

export const threadSummarySchema = z.object({
    id: z.uuid(),
    roomId: z.uuid(),
    createdAt: z.string(),
    retiredAt: z.string().nullable(),
    title: z.string().min(1).max(80),
    titleSource: z.enum(threadTitleSources),
    runStatus: z.enum(["running", "finished", "failed", "cancelled"]),
    currentRunId: z.uuid().nullable(),
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export const threadCursorSchema = z.object({
    createdAt: z.string(),
    id: z.uuid(),
});
export type ThreadCursor = z.infer<typeof threadCursorSchema>;

export const listThreadsQuerySchema = z.object({
    archived: z
        .enum(["true", "false"])
        .default("false")
        .transform((v) => v === "true"),
    cursor: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(50),
});

export const createThreadRequestSchema = z.object({
    creationId: z.uuid(),
});

export const updateThreadRequestSchema = z.discriminatedUnion("action", [
    z.object({
        action: z.literal("rename"),
        title: z.string().trim().min(1).max(80),
    }),
    z.object({ action: z.literal("archive") }),
    z.object({ action: z.literal("restore") }),
]);
export type UpdateThreadRequest = z.infer<typeof updateThreadRequestSchema>;

export type ThreadPage = {
    threads: Array<ThreadSummary>;
    nextCursor: string | null;
};

export function encodeThreadCursor(cursor: ThreadCursor): string {
    const value = JSON.stringify(threadCursorSchema.parse(cursor));
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
}

export function decodeThreadCursor(value: string): ThreadCursor | null {
    try {
        const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
        const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return threadCursorSchema.parse(
            JSON.parse(new TextDecoder().decode(bytes)),
        );
    } catch {
        return null;
    }
}
