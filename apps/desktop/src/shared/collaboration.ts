import { z } from "zod";
import type { Room } from "./contracts";
import { harnessIdSchema } from "./tabs";

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
  // Server time minus local time at the last snapshot, for read-along ages.
  clockOffsetMs?: number;
}

export const SHARED_TAB_STATUSES = [
  "running",
  "awaiting_host",
  "idle",
  "interrupted",
  "ended",
  "closed",
] as const;
export type SharedTabStatus = (typeof SHARED_TAB_STATUSES)[number];
export const deviceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
// Another member's (or this account's other desktop's) read-along tab record.
export const sharedTabSchema = z.object({
  tabId: z.uuid(),
  roomId: z.uuid(),
  hostId: z.uuid(),
  // A host without a profile row has no name.
  hostName: z
    .string()
    .max(200)
    .nullable()
    .transform((name) => name ?? "A member"),
  deviceId: deviceIdSchema,
  title: z.string().max(200),
  harness: harnessIdSchema,
  model: z.string().max(200),
  status: z.enum(SHARED_TAB_STATUSES),
  switchOn: z.boolean(),
  rev: z.number().int().nonnegative(),
  updatedAt: z.string(),
});
export type SharedTab = z.infer<typeof sharedTabSchema> & {
  // Set by the coordinator for this account's tabs on another desktop.
  sameUser?: boolean;
};

// One published entry as a viewer receives it; main parses every pulled row with this schema.
export const sharedEntrySchema = z
  .object({
    seq: z.number().int().positive(),
    kind: z.enum([
      "user",
      "assistant",
      "plan",
      "tool",
      "approval",
      "notice",
      "error",
      "turn",
    ]),
    share: z.enum(["full", "summary"]),
    summary: z.string().max(400),
    text: z.string().max(200_000).optional(),
    detail: z.string().max(65_536).optional(),
    state: z
      .enum(["pending", "accepted", "declined", "answered", "cancelled"])
      .optional(),
    outcome: z
      .enum(["completed", "stopped", "failed", "interrupted"])
      .optional(),
    notice: z
      .string()
      .regex(/^[a-z_]{1,40}$/)
      .optional(),
    version: z.number().int().positive(),
    rev: z.number().int().positive(),
    updatedAt: z.string().max(64),
  })
  .strict();
export type SharedEntry = z.infer<typeof sharedEntrySchema>;
// The envelope ignores fields a newer server adds; rows stay strict.
export const sharedPullSchema = z.object({
  record: sharedTabSchema,
  entries: z.array(sharedEntrySchema).max(200),
  next: z
    .object({
      rev: z.number().int().nonnegative(),
      seq: z.number().int().nonnegative(),
    })
    .strict()
    .nullable(),
  now: z.string().max(64),
});

// What main sends the renderer about the one watched shared tab.
export type SharedTranscriptMessage =
  | {
      type: "entries";
      roomId: string;
      tabId: string;
      record: SharedTab;
      entries: SharedEntry[];
      // Set on the initial page and "load earlier" pages: the seq to page before, or null.
      earlierSeq?: number | null;
      now: string;
    }
  | {
      type: "status";
      roomId: string;
      tabId: string;
      state: "loading" | "failed" | "reconnecting" | "live" | "unshared";
    }
  // The account changed or signed out: drop every shared transcript.
  | { type: "clear" };

// What the host's switch caption shows for one tab.
export type ReadAlongStatus =
  | { state: "publishing" }
  | { state: "paused"; buffered: number }
  | { state: "stopped"; reason: "not_member" | "migration_missing" };

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
      // Added by the read-along migration; older databases omit it.
      // Parsed per row in asSharedRoom, so one bad row never fails the snapshot.
      sharedTabs: z.array(z.unknown()).max(1_000).optional(),
    }),
  ),
  now: z.string().optional(),
});
export type SharedRoom = z.infer<typeof sharedSnapshotSchema>["rooms"][number];
export interface SharedRoomScope {
  userId: string;
  project: string;
  isAdmin: boolean;
  members: SharedRoom["members"];
  // Read-along tabs published to the room, never this desktop's own local tabs.
  sharedTabs?: SharedTab[];
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
  { sharedTabs, ...room }: SharedRoom,
  userId: string,
  project: string,
): Room {
  return {
    ...room,
    shared: {
      userId,
      project,
      isAdmin: room.isAdmin,
      members: room.members,
      sharedTabs: (sharedTabs ?? []).flatMap((item) => {
        const parsed = sharedTabSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      }),
    },
    workspace: null,
    tabs: [],
  };
}
