import z from "zod";

export const createRoomSchema = z.object({
    name: z
        .string()
        .trim()
        .min(1, "Room name is required")
        .max(50, "Maximum length is 25 characters"),
});

export type CreateRoomInput = z.infer<typeof createRoomSchema>;
