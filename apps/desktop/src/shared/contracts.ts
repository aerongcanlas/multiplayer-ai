import { z } from "zod";
import type {
  CollaborationState,
  ReadAlongStatus,
  RoomNotice,
  SharedRoomScope,
  SharedTranscriptMessage,
} from "./collaboration";
import {
  tabCommandSchemas,
  type HarnessId,
  type HarnessState,
  type Loadout,
  type Tab,
  type TranscriptBatch,
  type TranscriptPage,
} from "./tabs";

import { PROTOCOL_VERSION } from "./channels";
export {
  PROTOCOL_VERSION,
  COMMAND_CHANNEL,
  SNAPSHOT_CHANNEL,
  HEALTH_CHANNEL,
  TRANSCRIPT_CHANNEL,
  SHARED_TRANSCRIPT_CHANNEL,
} from "./channels";

const id = z.uuid();
const text = z.string().trim().min(1).max(8_000);
export const commandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("approval.respond"),
      roomId: id,
      tabId: id,
      approvalId: id,
      decision: z.enum(["accept", "decline"]),
    })
    .strict(),
  z.object({ type: z.literal("auth.signIn") }).strict(),
  z.object({ type: z.literal("auth.cancel") }).strict(),
  z.object({ type: z.literal("auth.signOut") }).strict(),
  z.object({ type: z.literal("shared.refresh") }).strict(),
  z
    .object({
      type: z.literal("room.join"),
      token: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_-]{43}$/),
    })
    .strict(),
  z.object({ type: z.literal("invite.create"), roomId: id }).strict(),
  z.object({ type: z.literal("snapshot") }).strict(),
  z
    .object({
      type: z.literal("room.create"),
      name: z.string().trim().min(1).max(80),
      scope: z.enum(["local", "shared"]).optional(),
    })
    .strict(),
  z.object({ type: z.literal("workspace.select"), roomId: id }).strict(),
  z.object({ type: z.literal("message.send"), roomId: id, text }).strict(),
  z
    .object({
      type: z.literal("suggestion.create"),
      roomId: id,
      messageIds: z
        .array(id)
        .min(1)
        .max(100)
        .refine((values) => new Set(values).size === values.length),
    })
    .strict(),
  z
    .object({
      type: z.literal("suggestion.edit"),
      roomId: id,
      suggestionId: id,
      prompt: text,
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  // Viewing another host's read-along tab; handled by main, never the supervisor.
  z
    .object({ type: z.literal("sharedTab.watch"), roomId: id, tabId: id })
    .strict(),
  z.object({ type: z.literal("sharedTab.unwatch") }).strict(),
  z
    .object({
      type: z.literal("sharedTab.load"),
      roomId: id,
      tabId: id,
      beforeSeq: z.number().int().positive(),
    })
    .strict(),
  ...tabCommandSchemas,
]);

export type Command = z.infer<typeof commandSchema>;
export type HarnessCommand = Extract<Command, { type: `harness.${string}` }>;
export const isHarnessCommand = (command: Command): command is HarnessCommand =>
  command.type.startsWith("harness.");

export interface Workspace {
  id: string;
  name: string;
  branch: string;
  revision: string;
  dirty: boolean;
  // The absolute path is held only by the supervisor journal, never in shared events.
}

export interface ChatMessage {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  createdAt: string;
}

export interface Suggestion {
  authorId?: string;
  id: string;
  prompt: string;
  // Always 0 since lead summaries were removed; kept for the shared-room wire format.
  contextVersion: number;
  sourceMessageIds: string[];
  sources: ChatMessage[];
  revision: number;
  status: "draft" | "submitted";
  createdAt: string;
  updatedAt: string;
}

export interface Room {
  shared?: SharedRoomScope;
  id: string;
  name: string;
  createdAt: string;
  workspace: Workspace | null;
  messages: ChatMessage[];
  suggestions: Suggestion[];
  tabs: Tab[];
  // Closed tabs, newest first; each keeps its transcript and can reopen.
  closedTabs?: Tab[];
}

export interface Snapshot {
  harnesses?: HarnessState[];
  collaboration?: CollaborationState;
  protocolVersion: typeof PROTOCOL_VERSION;
  revision: number;
  hostId: string;
  rooms: Room[];
  sync: "local-only";
  // Main's publisher status per read-along tab, keyed by tab ID.
  readAlong?: Record<string, ReadAlongStatus>;
}

export type Result =
  | {
      ok: true;
      snapshot: Snapshot;
      notice?: RoomNotice;
      transcript?: TranscriptPage;
    }
  | { ok: false; error: string };
export interface Health {
  status: "connecting" | "live" | "stale";
  message: string;
}

// Each method corresponds to one validated operation. No arbitrary IPC, paths, or commands.
export interface DesktopBridge {
  protocolVersion: typeof PROTOCOL_VERSION;
  getSnapshot(): Promise<Result>;
  createRoom(name: string, scope?: "local" | "shared"): Promise<Result>;
  signIn(): Promise<Result>;
  cancelSignIn(): Promise<Result>;
  signOut(): Promise<Result>;
  refreshShared(): Promise<Result>;
  joinRoom(token: string): Promise<Result>;
  createInvite(roomId: string): Promise<Result>;
  selectWorkspace(roomId: string): Promise<Result>;
  sendMessage(roomId: string, text: string): Promise<Result>;
  createSuggestion(roomId: string, messageIds: string[]): Promise<Result>;
  editSuggestion(
    roomId: string,
    suggestionId: string,
    prompt: string,
    expectedRevision: number,
  ): Promise<Result>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
  onHealth(listener: (health: Health) => void): () => void;
  openTab(roomId: string, harness: HarnessId): Promise<Result>;
  renameTab(roomId: string, tabId: string, title: string): Promise<Result>;
  closeTab(roomId: string, tabId: string, confirm?: boolean): Promise<Result>;
  setLoadout(roomId: string, tabId: string, loadout: Loadout): Promise<Result>;
  sendToTab(
    input: Omit<Extract<Command, { type: "tab.send" }>, "type">,
  ): Promise<Result>;
  stopTab(roomId: string, tabId: string): Promise<Result>;
  reopenTab(roomId: string, tabId: string): Promise<Result>;
  setReadAlong(roomId: string, tabId: string, on: boolean): Promise<Result>;
  // The page arrives in the Result's `transcript` field.
  loadTranscript(
    roomId: string,
    tabId: string,
    beforeSeq?: number,
    agentKey?: string,
  ): Promise<Result>;
  // The tab's sub-agent cards arrive in the Result's `transcript` field.
  loadAgents(roomId: string, tabId: string): Promise<Result>;
  resetTabSession(roomId: string, tabId: string): Promise<Result>;
  respondToTabApproval(
    roomId: string,
    tabId: string,
    approvalId: string,
    decision: "accept" | "decline",
  ): Promise<Result>;
  answerQuestion(
    roomId: string,
    tabId: string,
    questionId: string,
    answers: Record<string, string[]>,
  ): Promise<Result>;
  refreshHarness(harness: HarnessId): Promise<Result>;
  signInHarness(harness: HarnessId): Promise<Result>;
  chooseHarnessExecutable(harness: HarnessId): Promise<Result>;
  useManagedHarness(harness: HarnessId): Promise<Result>;
  acknowledgeHarnessNotice(harness: HarnessId): Promise<Result>;
  onTranscript(listener: (batches: TranscriptBatch[]) => void): () => void;
  // Read-along: one watched shared tab at a time; entries arrive on onSharedTranscript.
  watchSharedTab(roomId: string, tabId: string): Promise<Result>;
  unwatchSharedTab(): Promise<Result>;
  loadSharedTranscript(
    roomId: string,
    tabId: string,
    beforeSeq: number,
  ): Promise<Result>;
  onSharedTranscript(
    listener: (message: SharedTranscriptMessage) => void,
  ): () => void;
}

export interface PrivateWorkspace extends Workspace {
  path: string;
}
export interface SupervisorRequest {
  id: string;
  command:
    | Command
    | { type: "shared.import"; room: Room }
    | {
        type: "workspace.register";
        roomId: string;
        workspace: PrivateWorkspace;
      }
    // Main-only: a path chosen in a native dialog, or null for the managed program.
    | { type: "harness.setExecutable"; harness: HarnessId; path: string | null }
    // Main-only: the host's login-shell environment for harness launches.
    | { type: "host.environment"; env: Record<string, string> };
}
export type SupervisorMessage =
  | { type: "open-login"; harness: HarnessId; url: string }
  | { type: "transcript"; batches: TranscriptBatch[] }
  | { type: "ready"; snapshot: Snapshot }
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "heartbeat" }
  | { type: "response"; id: string; result: Result };
