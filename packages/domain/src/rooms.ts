import z from "zod";

export const createRoomSchema = z.object({
    name: z.string().trim().min(1, "Room name is required"),
});

export type CreateRoomInput = z.infer<typeof createRoomSchema>;
