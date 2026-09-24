import { randomUUID } from "node:crypto";
import type { HarnessId, HarnessModel, Loadout } from "../../shared/tabs";
import {
  HarnessError,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessSession,
  type Inspection,
  type LaunchContext,
  type OpenRequest,
} from "./contract";

// A scripted adapter for tests and MP_E2E only. Prompt markers select the behavior:
// FAKE_APPROVAL, FAKE_QUESTION, FAKE_EXIT_PLAN, FAKE_SLOW, FAKE_THROW, FAKE_SIGNOUT, FAKE_USAGE,
// and FAKE_CRASH. Options make resumes fail or fail the first turn after a resume.
const STOPPED = Symbol("stopped");
type Waiting = (value: unknown) => void;

export class FakeSession implements HarnessSession {
  sessionId: string | undefined;
  private pending = new Map<string, Waiting>();
  private stopped = false;
  private turns = 0;
  constructor(
    private harness: FakeHarness,
    readonly request: OpenRequest,
  ) {
    this.sessionId = request.sessionId;
  }

  private wait(request: string) {
    return new Promise<unknown>((resolve) =>
      this.pending.set(request, resolve),
    );
  }

  async *send(prompt: string, loadout: Loadout): AsyncIterable<HarnessEvent> {
    this.stopped = false;
    this.turns++;
    this.harness.calls.push(`send:${prompt}`);
    this.harness.loadouts.push(structuredClone(loadout));
    if (!this.sessionId) {
      this.sessionId = randomUUID();
      yield { type: "session", sessionId: this.sessionId };
    }
    if (
      this.harness.failFirstResumedTurn &&
      this.request.sessionId &&
      this.turns === 1
    )
      throw new HarnessError(
        "failed",
        "The resumed session could not continue.",
      );
    if (prompt.includes("FAKE_THROW"))
      throw new HarnessError("failed", "Fake failure.");
    if (prompt.includes("FAKE_SIGNOUT"))
      throw new HarnessError("signed_out", "Signed out of the fake harness.");
    if (prompt.includes("FAKE_USAGE"))
      throw new HarnessError(
        "usage_limit",
        "Usage limit reached.",
        2_000_000_000,
      );
    if (prompt.includes("FAKE_CRASH"))
      throw new HarnessError("crashed", "The fake harness exited.");
    if (prompt.includes("FAKE_SLOW")) {
      await this.wait("slow");
      return;
    }
    if (prompt.includes("FAKE_APPROVAL")) {
      yield {
        type: "approval",
        request: "approval-1",
        summary: "Run command: git status",
        detail: "The fake harness wants to inspect the checkout.",
      };
      const decision = await this.wait("approval-1");
      if (decision === STOPPED) return;
      if (decision === "accept")
        yield {
          type: "tool",
          item: "cmd-1",
          summary: "git status",
          detail: "nothing to commit",
        };
    }
    if (prompt.includes("FAKE_QUESTION")) {
      yield {
        type: "question",
        request: "question-1",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope should the change cover?",
            options: [
              { label: "Small", description: "Just this file" },
              { label: "Large", description: "The whole module" },
            ],
            multiSelect: false,
            allowOther: true,
            secret: false,
          },
        ],
      };
      const answers = await this.wait("question-1");
      if (answers === STOPPED) return;
      yield {
        type: "message",
        item: "answer",
        kind: "assistant",
        text: `You chose ${JSON.stringify(answers)}.`,
      };
      return;
    }
    if (loadout.planMode) {
      yield {
        type: "message",
        item: "plan",
        kind: "plan",
        text: "1. Inspect\n2. Change",
      };
      if (prompt.includes("FAKE_EXIT_PLAN")) {
        yield {
          type: "approval",
          request: "exit-plan",
          summary: "Ready to implement the plan",
          plan: true,
        };
        const decision = await this.wait("exit-plan");
        if (decision !== "accept") return;
      } else return;
    }
    yield {
      type: "text",
      item: "reasoning",
      kind: "reasoning",
      delta: "Thinking",
    };
    for (const delta of ["Hel", "lo", "!"])
      yield { type: "text", item: "reply", kind: "assistant", delta };
  }

  respond(request: string, decision: "accept" | "decline") {
    this.harness.calls.push(`respond:${request}:${decision}`);
    const waiting = this.pending.get(request);
    if (!waiting) throw new Error("That request is no longer pending.");
    this.pending.delete(request);
    waiting(decision);
  }

  answer(request: string, answers: Record<string, string[]>) {
    this.harness.calls.push(`answer:${request}`);
    const waiting = this.pending.get(request);
    if (!waiting) throw new Error("That question is no longer pending.");
    this.pending.delete(request);
    waiting(answers);
  }

  async stop() {
    for (const [request, waiting] of this.pending) {
      this.harness.calls.push(`cancel:${request}`);
      waiting(STOPPED);
    }
    this.pending.clear();
    this.stopped = true;
    this.harness.calls.push("stop");
  }

  close() {
    this.harness.calls.push("close");
    void this.stop();
  }
}

export class FakeHarness implements HarnessAdapter {
  readonly signIn: "in_app" | "guidance";
  calls: string[] = [];
  loadouts: Loadout[] = [];
  sessions: FakeSession[] = [];
  signedIn: boolean;
  models: HarnessModel[];
  inspectDelayMs: number;
  resumable: boolean;
  failFirstResumedTurn: boolean;
  private listeners: (() => void)[] = [];

  constructor(
    readonly id: HarnessId = "codex",
    options: {
      signedIn?: boolean;
      models?: HarnessModel[];
      inspectDelayMs?: number;
      signIn?: "in_app" | "guidance";
      resumable?: boolean;
      failFirstResumedTurn?: boolean;
    } = {},
  ) {
    this.resumable = options.resumable ?? true;
    this.failFirstResumedTurn = options.failFirstResumedTurn ?? false;
    this.signedIn = options.signedIn ?? true;
    this.inspectDelayMs = options.inspectDelayMs ?? 0;
    this.signIn = options.signIn ?? "in_app";
    this.models = options.models ?? [
      {
        id: "fake-model",
        name: "Fake model",
        efforts: ["low", "medium"],
        defaultEffort: "medium",
        isDefault: true,
      },
    ];
  }

  async handshake(context: LaunchContext) {
    this.calls.push(`handshake:${context.executable}`);
    return { version: "0.0.0-fake" };
  }

  async inspect(context: LaunchContext): Promise<Inspection> {
    this.calls.push(`inspect:${context.executable}`);
    if (this.inspectDelayMs)
      await new Promise((resolve) => setTimeout(resolve, this.inspectDelayMs));
    return this.signedIn
      ? {
          auth: { state: "signed_in", account: "fake@example.invalid" },
          models: structuredClone(this.models),
          limits: [],
        }
      : {
          auth: {
            state: "signed_out",
            message: "Sign in to the fake harness.",
          },
          models: [],
          limits: [],
        };
  }

  async startSignIn() {
    this.signedIn = true;
    setTimeout(() => this.listeners.forEach((listener) => listener()), 10);
    return "https://auth.openai.com/fake";
  }

  async open(request: OpenRequest): Promise<HarnessSession> {
    this.calls.push(`open:${request.sessionId ?? "new"}`);
    if (request.sessionId && !this.resumable)
      throw new HarnessError(
        "resume_failed",
        "The fake harness has no such session.",
      );
    const session = new FakeSession(this, request);
    this.sessions.push(session);
    return session;
  }

  onChange(listener: () => void) {
    this.listeners.push(listener);
  }

  close() {
    this.calls.push("adapter.close");
  }
}
