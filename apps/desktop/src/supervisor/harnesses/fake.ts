import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  HarnessId,
  HarnessModel,
  Loadout,
  SlashCommand,
} from "../../shared/tabs";
import {
  HarnessError,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessSession,
  type Inspection,
  type LaunchContext,
  type OpenRequest,
  type SignInStart,
  type SessionEvent,
} from "./contract";
import { HOME_VARIABLES, type AccountSpec } from "./accounts";

// A scripted adapter for tests. Prompt markers select the behavior: FAKE_APPROVAL, FAKE_QUESTION,
// FAKE_EXIT_PLAN, FAKE_SLOW, FAKE_THROW, FAKE_SIGNOUT, FAKE_USAGE, and FAKE_AGENTS. Options make
// resumes fail or fail the first turn after a resume.
const STOPPED = Symbol("stopped");
type Waiting = (value: unknown) => void;

class FakeSession implements HarnessSession {
  sessionId: string | undefined;
  private pending = new Map<string, Waiting>();
  private stopped = false;
  private turns = 0;
  private running = new Set<string>();
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

  /**
   * Reports an event on the session listener, as a harness does outside the turn iterator. A
   * request resolves with the host's answer.
   */
  emit(event: SessionEvent) {
    const answer =
      event.type === "approval" || event.type === "question"
        ? this.wait(event.request)
        : undefined;
    this.request.listener?.(event);
    return answer;
  }

  private agent(event: Omit<Extract<HarnessEvent, { type: "agent" }>, "type">) {
    if (event.status === "running") this.running.add(event.key);
    else if (event.status) this.running.delete(event.key);
    this.emit({ type: "agent", ...event });
  }

  // The background sub-agent of FAKE_AGENTS: it asks for approval during the turn and again after
  // it, then completes and wakes the lead with a turn of its own.
  private async background() {
    const first = this.emit({
      type: "approval",
      agent: "tests",
      request: "tests-1",
      summary: "Run command: pnpm test",
    });
    if ((await first) === STOPPED) return;
    await delay(100);
    this.emit({
      type: "tool",
      agent: "tests",
      item: "test",
      summary: "pnpm test",
      detail: "12 passed",
    });
    const second = this.emit({
      type: "approval",
      agent: "tests",
      request: "tests-2",
      summary: "Run command: pnpm lint",
    });
    if ((await second) === STOPPED) return;
    this.agent({
      key: "tests",
      status: "completed",
      summary: "All tests passed.",
    });
    this.emit({ type: "turn.started" });
    this.emit({
      type: "message",
      item: "wake",
      kind: "assistant",
      text: "The background tests passed.",
    });
    this.emit({ type: "turn.completed" });
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
    if (prompt.includes("FAKE_AGENTS")) {
      yield {
        type: "steps",
        steps: [
          { text: "Inspect the checkout", status: "done" },
          { text: "Run the tests", status: "active" },
        ],
      };
      this.agent({
        key: "inspect",
        description: "Inspect the checkout",
        agentType: "Explore",
        status: "running",
      });
      this.emit({
        type: "tool",
        agent: "inspect",
        item: "ls",
        summary: "ls",
        detail: "README.md",
      });
      this.agent({
        key: "readme",
        parentKey: "inspect",
        description: "Read the README",
        agentType: "Explore",
        status: "running",
      });
      this.emit({
        type: "message",
        agent: "readme",
        item: "reply",
        kind: "assistant",
        text: "The README is short.",
      });
      this.agent({
        key: "readme",
        status: "completed",
        summary: "The README is short.",
      });
      this.agent({
        key: "tests",
        description: "Run the test suite",
        agentType: "general-purpose",
        background: true,
        status: "running",
      });
      void this.background();
      this.emit({
        type: "message",
        agent: "inspect",
        item: "reply",
        kind: "assistant",
        text: "Found README.md.",
      });
      this.agent({
        key: "inspect",
        status: "completed",
        summary: "Found README.md.",
      });
      yield {
        type: "message",
        item: "reply",
        kind: "assistant",
        text: "The tests keep running in the background.",
      };
      return;
    }
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
    for (const key of this.running)
      this.emit({ type: "agent", key, status: "stopped" });
    this.running.clear();
    this.stopped = true;
    this.harness.calls.push("stop");
  }

  close() {
    this.harness.calls.push("close");
    void this.stop();
  }
}

export class FakeHarness implements HarnessAdapter {
  async suggest() {
    this.calls.push("suggest");
    return {
      actionable: true,
      summary: "Review the selected feedback.",
      suggestedPrompts: [
        "Review the selected feedback and propose the next concrete change.",
      ],
      unresolved: [],
    };
  }
  readonly signIn: "in_app" | "guidance";
  readonly account?: AccountSpec;
  readonly reportsAgents = true;
  calls: string[] = [];
  // How sign-in behaves: "auto" finishes shortly; "manual" waits for finishSignIn.
  signInMode: "auto" | "manual" = "auto";
  signInUrl: string | undefined = "https://auth.openai.com/fake";
  // Set, startSignIn throws it.
  signInError?: string;
  private pendingSignIn?: {
    resolve: () => void;
    reject: (error: Error) => void;
  };
  loadouts: Loadout[] = [];
  sessions: FakeSession[] = [];
  signedIn: boolean;
  models: HarnessModel[];
  slashCommands: SlashCommand[] = [
    { name: "review", description: "Review the current changes" },
    { name: "plan", description: "Plan a change", argumentHint: "<goal>" },
  ];
  outputStyles?: string[];
  inspectDelayMs: number;
  resumable: boolean;
  failFirstResumedTurn: boolean;
  private listeners: (() => void)[] = [];

  constructor(
    readonly id: HarnessId = "codex",
    options: {
      inspectDelayMs?: number;
      signIn?: "in_app" | "guidance";
      resumable?: boolean;
      failFirstResumedTurn?: boolean;
      account?: AccountSpec;
    } = {},
  ) {
    this.resumable = options.resumable ?? true;
    this.failFirstResumedTurn = options.failFirstResumedTurn ?? false;
    this.signedIn = true;
    this.inspectDelayMs = options.inspectDelayMs ?? 0;
    this.signIn = options.signIn ?? "in_app";
    const variable = HOME_VARIABLES[id];
    this.account = options.account ?? (variable ? { variable } : undefined);
    this.models = [
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
          auth: {
            state: "signed_in",
            account: "fake@example.invalid",
            signOut: true,
          },
          models: structuredClone(this.models),
          limits: [],
          ...(this.outputStyles ? { outputStyles: this.outputStyles } : {}),
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

  async commands(request: LaunchContext & { cwd: string }) {
    this.calls.push(`commands:${request.cwd}`);
    return structuredClone(this.slashCommands);
  }

  async startSignIn(): Promise<SignInStart> {
    this.calls.push("startSignIn");
    if (this.signInError) throw new Error(this.signInError);
    const done = new Promise<void>((resolve, reject) => {
      this.pendingSignIn = { resolve, reject };
    });
    if (this.signInMode === "auto") setTimeout(() => this.finishSignIn(), 10);
    return {
      state: "pending",
      ...(this.signInUrl ? { url: this.signInUrl } : {}),
      done,
    };
  }

  /** Completes the pending sign-in, or fails it with `error`. */
  finishSignIn(error?: string) {
    const pending = this.pendingSignIn;
    this.pendingSignIn = undefined;
    if (!pending) return;
    if (error) return pending.reject(new Error(error));
    this.signedIn = true;
    pending.resolve();
    this.listeners.forEach((listener) => listener());
  }

  async cancelSignIn() {
    this.calls.push("cancelSignIn");
    this.pendingSignIn = undefined;
  }

  async signOut(context: LaunchContext) {
    this.calls.push(
      `signOut:${this.account ? context.env[this.account.variable] : ""}`,
    );
    this.signedIn = false;
  }

  async open(request: OpenRequest): Promise<HarnessSession> {
    this.calls.push(`open:${request.sessionId ?? "new"}`);
    if (request.outputStyle) this.calls.push(`style:${request.outputStyle}`);
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
