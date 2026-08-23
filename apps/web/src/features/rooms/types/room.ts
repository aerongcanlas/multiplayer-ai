import type { Tables } from "@multiplayer-ai/db";

type RoomRow = Tables<"room">;
type RoomMemberRow = Tables<"room_member">;
type MessageRow = Tables<"message">;
type ProfileRow = Tables<"user_profile">;

export type RoomAccess = RoomRow & {
    currentUserIsAdmin: RoomMemberRow["is_admin"];
};

export type RoomPageMember = {
    user_profile: Pick<ProfileRow, "id" | "image_url" | "name">;
    is_admin: RoomMemberRow["is_admin"];
    member_id: RoomMemberRow["member_id"];
};

export type RoomPageMessage = {
    id: MessageRow["id"];
    room_id: MessageRow["room_id"];
    author_id: MessageRow["author_id"];
    text: MessageRow["text"];
    created_at: MessageRow["created_at"];
    author: {
        id: ProfileRow["id"];
        name: ProfileRow["name"];
        image_url: ProfileRow["image_url"];
    };
};

export type JoinedRoom = Pick<
    RoomRow,
    "id" | "name" | "slug" | "created_at"
> & {
    member_count: number;
    last_visited_at: RoomMemberRow["last_visited_at"];
};

export type SendMessageResult =
    | {
          success: true;
          message: RoomPageMessage;
      }
    | { success: false; error: string };

export type RoomChatMessage = RoomPageMessage & {
    deliveryStatus?: "sending" | "failed";
};
