import { z } from "zod";
import {
  runConfigurationSchema,
  type ProviderState,
  type RunApproval,
  type RunConfiguration,
} from "./provider";
import type {
  CollaborationState,
  RoomNotice,
  SharedRoomScope,
} from "./collaboration";

import { PROTOCOL_VERSION } from "./channels";
export {
  PROTOCOL_VERSION,
  COMMAND_CHANNEL,
  SNAPSHOT_CHANNEL,
  HEALTH_CHANNEL,
} from "./channels";

const id = z.uuid();
const text = z.string().trim().min(1).max(8_000);
export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("provider.refresh") }).strict(),
  z.object({ type: z.literal("provider.connect") }).strict(),
  z.object({ type: z.literal("provider.cancel") }).strict(),
  z.object({ type: z.literal("provider.disconnect") }).strict(),
  z
    .object({
      type: z.literal("approval.respond"),
      roomId: id,
      executionId: id,
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
  z
    .object({
      type: z.literal("execution.start"),
      roomId: id,
      prompt: text,
      suggestionId: id.optional(),
      suggestionRevision: z.number().int().positive().optional(),
      scenario: z.enum(["success", "validation-failure"]).default("success"),
      runner: z.enum(["mock", "codex"]).optional(),
      configuration: runConfigurationSchema.optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("execution.stop"), roomId: id, executionId: id })
    .strict(),
]);

export type Command = z.infer<typeof commandSchema>;
export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_for_input"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";
export type Role =
  "lead" | "planner" | "designer" | "implementer" | "validator";
export type ExecutionStatus =
  "running" | "completed" | "failed" | "cancelled" | "blocked";

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
  contextVersion: number;
  sourceMessageIds: string[];
  sources: ChatMessage[];
  revision: number;
  status: "draft" | "submitted";
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  agentId: string;
  parentId: string | null;
  role: Role;
  objective: string;
  criteria: string;
  dependencies: string[];
  status: TaskStatus;
  contextVersion: number;
  inputRevision: string;
  workspaceId: string;
  activity: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface Evidence {
  id: string;
  taskId: string;
  label: string;
  outcome: "passed" | "failed";
  kind: "simulation" | "command" | "review" | "patch";
  detail: string;
  revision: string;
  recordedAt: string;
}

export interface ProgressEvent {
  id: string;
  seq: number;
  executionId: string;
  taskId: string;
  agentId: string;
  generation: number;
  type: "status" | "activity" | "evidence" | "summary" | "recovery";
  message: string;
  createdAt: string;
}

export interface ContextSummary {
  version: number;
  executionId: string;
  goal: string;
  decisions: string[];
  currentWork: string;
  uncertainties: string[];
  questions: string[];
  createdAt: string;
}

export interface Execution {
  id: string;
  roomId: string;
  hostId: string;
  generation: number;
  planVersion: number;
  runner: "mock" | "codex";
  configuration?: RunConfiguration;
  approvals?: RunApproval[];
  artifact?: {
    branch: string;
    revision: string;
    files: string[];
    diff: string;
  };
  scenario: "success" | "validation-failure";
  workspace: Workspace;
  prompt: string;
  contextVersion: number;
  sourceSuggestion: Suggestion | null;
  status: ExecutionStatus;
  startedAt: string;
  endedAt: string | null;
  tasks: Task[];
  events: ProgressEvent[];
  evidence: Evidence[];
}

export interface Room {
  shared?: SharedRoomScope;
  id: string;
  name: string;
  createdAt: string;
  workspace: Workspace | null;
  messages: ChatMessage[];
  suggestions: Suggestion[];
  executions: Execution[];
  summaries: ContextSummary[];
}

export interface Snapshot {
  provider?: ProviderState;
  collaboration?: CollaborationState;
  protocolVersion: typeof PROTOCOL_VERSION;
  revision: number;
  hostId: string;
  rooms: Room[];
  sync: "local-only";
}

export type Result =
  | { ok: true; snapshot: Snapshot; notice?: RoomNotice }
  | { ok: false; error: string };
export interface Health {
  status: "connecting" | "live" | "stale";
  message: string;
}

// Each method corresponds to one validated operation. No arbitrary IPC, paths, or commands.
export interface DesktopBridge {
  refreshProvider(): Promise<Result>;
  connectProvider(): Promise<Result>;
  cancelProviderLogin(): Promise<Result>;
  disconnectProvider(): Promise<Result>;
  respondToApproval(
    roomId: string,
    executionId: string,
    approvalId: string,
    decision: "accept" | "decline",
  ): Promise<Result>;
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
  startExecution(
    input: Omit<Extract<Command, { type: "execution.start" }>, "type">,
  ): Promise<Result>;
  stopExecution(roomId: string, executionId: string): Promise<Result>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
  onHealth(listener: (health: Health) => void): () => void;
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
      };
}
export type SupervisorMessage =
  | { type: "open-provider-login"; url: string }
  | { type: "ready"; snapshot: Snapshot }
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "heartbeat" }
  | { type: "response"; id: string; result: Result };

export { currentSummary, currentExecution } from "./selectors";
