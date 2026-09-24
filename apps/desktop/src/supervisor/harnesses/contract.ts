import type {
  HarnessId,
  HarnessModel,
  HarnessQuestion,
  HarnessState,
  Loadout,
} from "../../shared/tabs";

/** The resolved program and launch environment an adapter runs with. */
export interface LaunchContext {
  executable: string;
  env: Record<string, string>;
}

export interface Inspection {
  auth: HarnessState["auth"];
  models: HarnessModel[];
  limits: HarnessState["limits"];
}

export type HarnessEvent =
  // The harness session to resume later (a Codex thread or a Claude Code session).
  | { type: "session"; sessionId: string }
  // Streamed text; deltas with the same item coalesce into one entry.
  | {
      type: "text";
      item: string;
      kind: "assistant" | "reasoning" | "plan";
      delta: string;
    }
  // A whole text item, replacing any streamed deltas for that item.
  | {
      type: "message";
      item: string;
      kind: "assistant" | "reasoning" | "plan";
      text: string;
    }
  // Tool activity: a one-line shareable summary and local-only detail such as output.
  | { type: "tool"; item: string; summary: string; detail?: string }
  // A request the host approves or declines. `plan` marks a "continue into execution" request.
  | {
      type: "approval";
      request: string;
      summary: string;
      detail?: string;
      plan?: boolean;
    }
  | { type: "question"; request: string; questions: HarnessQuestion[] }
  | { type: "notice"; summary: string; notice?: "unsupported_request" };

export type HarnessErrorKind =
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
  /** Answers every pending request the way the harness expects for a stop, then interrupts. */
  stop(): Promise<void>;
  close(): void;
}

export interface OpenRequest extends LaunchContext {
  tabId: string;
  cwd: string;
  sessionId?: string;
  loadout: Loadout;
}

export interface HarnessAdapter {
  readonly id: HarnessId;
  readonly signIn: "in_app" | "guidance";
  /** Checks that a custom executable speaks the harness protocol. Returns its version. */
  handshake(context: LaunchContext): Promise<{ version: string | null }>;
  inspect(context: LaunchContext): Promise<Inspection>;
  /** Starts an in-app sign-in and returns the URL to open, or null when already signed in. */
  startSignIn?(context: LaunchContext): Promise<string | null>;
  open(request: OpenRequest): Promise<HarnessSession>;
  /** Harness-level changes such as a completed sign-in. */
  onChange?(listener: () => void): void;
  close(): void;
}
