import type { Database } from "@multiplayer-ai/db";

export type JoinedRoom = Database["public"]["Tables"]["room"]["Row"] & {
    memberCount: number;
};
