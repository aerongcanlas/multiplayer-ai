import type { Database } from "@/types/database.types";

export type JoinedRoom = Database["public"]["Tables"]["room"]["Row"] & {
    memberCount: number;
};
