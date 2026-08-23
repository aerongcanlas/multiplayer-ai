import z from "zod";

export const createRoomSchema = z.object({
    name: z
        .string()
        .trim()
        .min(1, "Room name is required")
        .max(50, "Maximum length is 25 characters"),
});

export const createRoomInviteSchema = z.object({
    roomId: z.uuid({ error: "Invalid room ID" }),
});

export const acceptRoomInviteSchema = z.object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Invalid invitation token"),
});

export type CreateRoomInput = z.infer<typeof createRoomSchema>;
export type CreateRoomInviteInput = z.infer<typeof createRoomInviteSchema>;
export type AcceptRoomInviteInput = z.infer<typeof acceptRoomInviteSchema>;
