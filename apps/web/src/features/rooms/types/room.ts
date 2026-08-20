import type { Database } from "@multiplayer-ai/db";

type RoomRow = Database["public"]["Tables"]["room"]["Row"];
type RoomMemberRow = Database["public"]["Tables"]["room_member"]["Row"];

export type JoinedRoom = Pick<
    RoomRow,
    "id" | "name" | "slug" | "created_at"
> & {
    member_count: number;
    last_visited_at: RoomMemberRow["last_visited_at"];
};
