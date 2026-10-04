import type { ContextSuggestionDraft } from "@multiplayer-ai/domain/context-suggestions";
import type { ChatMessage } from "../../shared/contracts";
import type {
  AgentStatus,
  HarnessId,
  HarnessModel,
  HarnessQuestion,
  HarnessState,
  Loadout,
  LocalServer,
  PlanStep,
  SlashCommand,
} from "../../shared/tabs";
import type { AccountSpec, HostPaths } from "./accounts";

/** The resolved program and launch environment an adapter runs with. */
export interface LaunchContext {
  executable: string;
  env: Record<string, string>;
  /**
   * The app-owned home folder `env` names for this harness (its login and session history);
   * empty for a harness that runs in the host's own folders (OpenCode).
   */
  home: string;
  /** The host's own home and harness folder variables, for finding host setup. Never launched with. */
  hostPaths: HostPaths;
  /** The host's output style for new sessions, where the harness has output styles. */
  outputStyle?: string;
  /** The host's saved default model, for harnesses that need a model before a tab picks one. */
  defaultModel?: string;
}

export interface SuggestionRequest extends LaunchContext {
  messages: ChatMessage[];
  model: HarnessModel;
}

export interface Inspection {
  auth: HarnessState["auth"];
  models: HarnessModel[];
  limits: HarnessState["limits"];
  outputStyles?: string[];
  // Model servers on this computer the harness found.
  localServers?: LocalServer[];
}

// `agent` names the sub-agent card an event belongs to; lead events leave it unset.
export type HarnessEvent =
  // The harness session to resume later (a Codex thread or a Claude Code session).
  | { type: "session"; sessionId: string }
  // Streamed text; deltas with the same item coalesce into one entry.
  | {
      type: "text";
      item: string;
      kind: "assistant" | "reasoning" | "plan";
      delta: string;
      agent?: string;
    }
  // A whole text item, replacing any streamed deltas for that item.
  | {
      type: "message";
      item: string;
      kind: "assistant" | "reasoning" | "plan";
      text: string;
      agent?: string;
    }
  // Tool activity: a one-line shareable summary and local-only detail such as output.
  | {
      type: "tool";
      item: string;
      summary: string;
      detail?: string;
      agent?: string;
    }
  // A request the host approves or declines. `plan` marks a "continue into execution" request.
  | {
      type: "approval";
      request: string;
      summary: string;
      detail?: string;
      plan?: boolean;
      agent?: string;
    }
  | {
      type: "question";
      request: string;
      questions: HarnessQuestion[];
      agent?: string;
    }
  | {
      type: "notice";
      summary: string;
      notice?: "unsupported_request";
      agent?: string;
    }
  // Creates or updates a sub-agent card. Fields left out keep their last value.
  | {
      type: "agent";
      key: string;
      parentKey?: string;
      description?: string;
      agentType?: string;
      name?: string;
      model?: string;
      status?: Exclude<AgentStatus, "interrupted">;
      background?: boolean;
      toolUses?: number;
      latestTool?: string;
      summary?: string;
    }
  // The lead's own plan, replacing the previous one.
  | { type: "steps"; steps: PlanStep[]; explanation?: string };

/** What a session reports outside the turn iterator. */
export type SessionEvent =
  | HarnessEvent
  // A lead turn the harness started by itself; its lead events follow on the listener.
  | { type: "turn.started" }
  | { type: "turn.completed" }
  | { type: "turn.failed"; error: HarnessError }
  // The harness process or query ended with no turn running.
  | { type: "crashed"; message: string };

type HarnessErrorKind =
  // The program is missing, failed to download, or is not signed in.
  | "unavailable"
  | "failed"
  | "usage_limit"
  | "signed_out"
  | "resume_failed"
  | "crashed";

export class HarnessError extends Error {
  constructor(
    readonly kind: HarnessErrorKind,
    message: string,
    readonly resetsAt: number | null = null,
  ) {
    super(message);
  }
}

export interface HarnessSession {
  readonly sessionId: string | undefined;
  /**
   * Runs one turn and yields its events. The iterator ends when the turn completes or stops, and
   * throws a HarnessError when the harness fails it.
   */
  send(prompt: string, loadout: Loadout): AsyncIterable<HarnessEvent>;
  respond(request: string, decision: "accept" | "decline"): void;
  answer(request: string, answers: Record<string, string[]>): void;
  /**
   * Answers every pending request the way the harness expects for a stop, then interrupts the lead
   * turn and all running background work, sub-agents included.
   */
  stop(): Promise<void>;
  close(): void;
}

export interface OpenRequest extends LaunchContext {
  tabId: string;
  cwd: string;
  sessionId?: string;
  loadout: Loadout;
  /** Receives sub-agent events, harness-started turns, and crashes, during or after a turn. */
  listener?: (event: SessionEvent) => void;
}

/** A started sign-in: already signed in, or waiting on the host to finish it in the browser. */
export type SignInStart =
  | { state: "signed_in" }
  // `done` settles when the harness reports the sign-in finished, or rejects with why it failed.
  | { state: "pending"; url?: string; done: Promise<void> };

export interface HarnessAdapter {
  readonly id: HarnessId;
  // In the app, by guidance only, or through a copy-ready terminal command.
  readonly signIn: "in_app" | "guidance" | "command";
  /**
   * The app-owned home this harness launches with, and the host setup carried into it. Left out,
   * the harness uses the host's own folders.
   */
  readonly account?: AccountSpec;
  /** Whether sessions report sub-agents on the session listener. */
  readonly reportsAgents: boolean;
  /** Checks that a custom executable speaks the harness protocol. Returns its version. */
  handshake(context: LaunchContext): Promise<{ version: string | null }>;
  inspect(context: LaunchContext): Promise<Inspection>;
  /** Starts an in-app sign-in. Only one is pending per harness at a time. */
  startSignIn?(context: LaunchContext): Promise<SignInStart>;
  /** Ends a pending sign-in, ending any program it started. */
  cancelSignIn?(): Promise<void>;
  /** Signs the app's own login out with the harness's own command; never the host's. */
  signOut?(context: LaunchContext): Promise<void>;
  open(request: OpenRequest): Promise<HarnessSession>;
  /** The slash commands and skills a session in `cwd` would offer. */
  commands?(request: LaunchContext & { cwd: string }): Promise<SlashCommand[]>;
  /** Generates drafts without opening a user-visible chat or running repository tools. */
  suggest?(request: SuggestionRequest): Promise<ContextSuggestionDraft>;
  /** Harness-level changes such as a completed sign-in. */
  onChange?(listener: () => void): void;
  close(): void;
}
