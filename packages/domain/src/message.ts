import z from "zod";

export const createMessageSchema = z.object({
    text: z.string().trim().min(1).max(1000),
    room_id: z.uuid(),
});

export type CreateMessageInput = z.infer<typeof createMessageSchema>;

export type Message = {
    id: string;
    room_id: string;
    author_id: string;
    text: string;
    created_at: string;
};

export function isMessage(value: unknown): value is Message {
    if (typeof value !== "object" || value === null) return false;

    const message = value as Record<string, unknown>;

    return (
        typeof message.id === "string" &&
        typeof message.room_id === "string" &&
        typeof message.author_id === "string" &&
        typeof message.text === "string" &&
        message.text.length > 0 &&
        message.text.length <= 2_000 &&
        typeof message.created_at === "string"
    );
}
