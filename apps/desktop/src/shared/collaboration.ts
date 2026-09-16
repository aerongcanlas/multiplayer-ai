import { z } from "zod";
import type { Room } from "./contracts";

export interface SharedAccount {
  id: string;
  name: string;
}
export interface CollaborationState {
  auth: "signed_out" | "signing_in" | "signed_in";
  account: SharedAccount | null;
  status:
    "disconnected" | "syncing" | "connected" | "offline" | "setup_required";
  message: string | null;
  lastSyncedAt: string | null;
}

const message = z.object({
  id: z.uuid(),
  authorId: z.uuid(),
  authorName: z.string(),
  text: z.string(),
  createdAt: z.string(),
});
export const sharedSnapshotSchema = z.object({
  version: z.literal(1),
  userId: z.uuid(),
  rooms: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      slug: z.string(),
      createdAt: z.string(),
      isAdmin: z.boolean(),
      members: z.array(z.object({ id: z.uuid(), name: z.string() })),
      messages: z.array(message),
      suggestions: z.array(
        z.object({
          id: z.uuid(),
          authorId: z.uuid(),
          prompt: z.string(),
          contextVersion: z.literal(0),
          sourceMessageIds: z.array(z.uuid()),
          sources: z.array(message),
          revision: z.number().int().positive(),
          status: z.literal("draft"),
          createdAt: z.string(),
          updatedAt: z.string(),
        }),
      ),
    }),
  ),
});
export type SharedRoom = z.infer<typeof sharedSnapshotSchema>["rooms"][number];
export interface SharedRoomScope {
  userId: string;
  project: string;
  isAdmin: boolean;
  members: SharedRoom["members"];
}
export type RoomNotice =
  { kind: "invite"; token: string } | { kind: "room"; roomId: string };

export const signedOutState = (): CollaborationState => ({
  auth: "signed_out",
  account: null,
  status: "disconnected",
  message: null,
  lastSyncedAt: null,
});

export function asSharedRoom(
  room: SharedRoom,
  userId: string,
  project: string,
): Room {
  return {
    ...room,
    shared: { userId, project, isAdmin: room.isAdmin, members: room.members },
    workspace: null,
    executions: [],
    summaries: [],
  };
}
