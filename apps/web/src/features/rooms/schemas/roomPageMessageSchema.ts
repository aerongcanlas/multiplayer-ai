import type { RoomPageMessage } from "@/features/rooms/types/room";
import { z } from "zod";

export const roomPageMessageSchema: z.ZodType<RoomPageMessage> = z.object({
    id: z.uuid(),
    room_id: z.uuid(),
    author_id: z.uuid(),
    text: z.string().min(1).max(1_000),
    created_at: z.string().min(1),
    author: z.object({
        id: z.uuid(),
        name: z.string().min(1),
        image_url: z.string().nullable(),
    }),
});
