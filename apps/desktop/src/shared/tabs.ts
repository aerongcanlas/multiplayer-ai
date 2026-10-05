import { z } from "zod";

export const HARNESS_IDS = ["codex", "claude", "opencode"] as const;
export const harnessIdSchema = z.enum(HARNESS_IDS);
export type HarnessId = z.infer<typeof harnessIdSchema>;
export const HARNESS_LABELS: Record<HarnessId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
};
// A one-time notice the host acknowledges before the harness's first tab; null for none.
export const HARNESS_NOTICES: Record<HarnessId, string | null> = {
  codex:
    "Codex tabs have their own ChatGPT sign-in, separate from Codex in your terminal, so signing in or out there never signs a tab out. Sign in once from Settings.",
  claude:
    "Claude Code tabs have their own sign-in, separate from Claude Code in your terminal, so signing in or out there never signs a tab out. Sign in from Settings: Claude Code opens Anthropic's page in your browser, and this app never sees your password or token.",
  opencode: null,
};
// Bumped when a notice's text changes enough that hosts who acknowledged it should see it again.
export const HARNESS_NOTICE_VERSIONS: Record<HarnessId, number> = {
  codex: 1,
  claude: 2,
  opencode: 1,
};

const id = z.uuid();
const effort = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,23}$/)
  .optional();

export const loadoutSchema = z
  .object({
    harness: harnessIdSchema,
    // Empty until the harness reports its models; a send needs a listed model.
    model: z.string().max(120),
    effort,
    planMode: z.boolean(),
    access: z.enum(["ask", "auto"]),
  })
  .strict();
export type Loadout = z.infer<typeof loadoutSchema>;

export const TAB_STATUSES = [
  "unavailable",
  "idle",
  "running",
  "awaiting_host",
  "error",
  "interrupted",
  "resume_failed",
] as const;
export type TabStatus = (typeof TAB_STATUSES)[number];

export const PLAN_STEP_STATUSES = ["pending", "active", "done"] as const;
export const tabPlanSchema = z
  .object({
    // The turn that last revised the plan; null once that turn is unknown.
    turnId: id.nullable(),
    explanation: z.string().max(4_000).optional(),
    steps: z
      .array(
        z
          .object({
            text: z.string().max(2_000),
            status: z.enum(PLAN_STEP_STATUSES),
          })
          .strict(),
      )
      .max(200),
    updatedAt: z.string(),
  })
  .strict();
export type TabPlan = z.infer<typeof tabPlanSchema>;
export type PlanStep = TabPlan["steps"][number];

const count = z.number().int().nonnegative().optional();

export const tabSchema = z
  .object({
    id,
    roomId: id,
    title: z.string().min(1).max(80),
    loadout: loadoutSchema,
    status: z.enum(TAB_STATUSES),
    sessionId: z.string().min(1).max(200).optional(),
    // Set after a resume until the first turn on the resumed session completes.
    resumed: z.boolean().optional(),
    // The host's read-along switch. Entries publish only inside an on-window: `onSeq` is the
    // first seq shared and `offSeq`, once the switch turns off, the first seq not shared.
    readAlong: z.boolean(),
    readAlongWindows: z
      .array(
        z
          .object({
            onSeq: z.number().int().positive(),
            offSeq: z.number().int().positive().nullable(),
          })
          .strict(),
      )
      .max(1_000)
      .default([]),
    // Set when the tab was closed; closed tabs keep their transcript and can reopen.
    closedAt: z.string().optional(),
    // The harness's own plan for the tab.
    plan: tabPlanSchema.optional(),
    // Sub-agents still running and sub-agent requests waiting on the owner.
    runningAgents: count,
    agentRequests: count,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type Tab = z.infer<typeof tabSchema>;

export const TRANSCRIPT_KINDS = [
  "user",
  "assistant",
  "reasoning",
  "plan",
  "tool",
  "approval",
  "question",
  "notice",
  "error",
  "turn",
  "agent",
] as const;
export type TranscriptKind = (typeof TRANSCRIPT_KINDS)[number];
export type ShareLevel = "full" | "summary" | "none";

// What each kind may share once read-along exists.
export const SHARE_LEVELS: Record<TranscriptKind, ShareLevel> = {
  user: "full",
  assistant: "full",
  reasoning: "none",
  plan: "full",
  tool: "summary",
  approval: "summary",
  question: "none",
  notice: "full",
  error: "summary",
  turn: "summary",
  agent: "full",
};

const questionSchema = z
  .object({
    id: z.string().min(1).max(200),
    header: z.string().max(200),
    question: z.string().min(1).max(4_000),
    options: z
      .array(
        z
          .object({
            label: z.string().min(1).max(400),
            description: z.string().max(2_000),
          })
          .strict(),
      )
      .max(20),
    multiSelect: z.boolean(),
    allowOther: z.boolean(),
    secret: z.boolean(),
  })
  .strict();
export type HarnessQuestion = z.infer<typeof questionSchema>;

const suggestionSourceSchema = z
  .object({
    suggestionId: id,
    revision: z.number().int().positive(),
    prompt: z.string().max(8_000),
    sources: z.array(
      z
        .object({
          id,
          authorId: id,
          authorName: z.string().max(200),
          text: z.string().max(8_000),
          createdAt: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export const AGENT_STATUSES = [
  "running",
  "completed",
  "failed",
  "stopped",
  "interrupted",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
const agentKey = z.string().min(1).max(200);
// A sub-agent card: the entry's summary is the task and its detail the final summary.
export const agentCardSchema = z
  .object({
    key: agentKey,
    parentKey: agentKey.optional(),
    type: z.string().max(200).optional(),
    name: z.string().max(200).optional(),
    model: z.string().max(200).optional(),
    status: z.enum(AGENT_STATUSES),
    background: z.boolean(),
    startedAt: z.string(),
    endedAt: z.string().optional(),
    toolUses: z.number().int().nonnegative(),
    latestTool: z.string().max(400).optional(),
  })
  .strict();
export type AgentCard = z.infer<typeof agentCardSchema>;

export const transcriptEntrySchema = z
  .object({
    id,
    tabId: id,
    seq: z.number().int().positive(),
    turnId: id.nullable(),
    kind: z.enum(TRANSCRIPT_KINDS),
    share: z.enum(["full", "summary", "none"]),
    // Shareable one-line text (or the message itself for full-share kinds).
    summary: z.string().max(200_000),
    // Local-only detail such as command output or a diff.
    detail: z.string().max(200_000).optional(),
    source: suggestionSourceSchema.optional(),
    // Set on entries a sub-agent produced, naming its card.
    agentKey: agentKey.optional(),
    agent: agentCardSchema.optional(),
    // Approval, plan, and question entries that wait on the host.
    state: z
      .enum(["pending", "accepted", "declined", "answered", "cancelled"])
      .optional(),
    // A plan the host can continue into execution with a follow-up turn.
    continuable: z.boolean().optional(),
    questions: z.array(questionSchema).max(10).optional(),
    // Turn outcomes and notices that offer an action.
    outcome: z
      .enum(["completed", "stopped", "failed", "interrupted"])
      .optional(),
    notice: z
      .enum([
        "interrupted",
        "resume_failed",
        "usage_limit",
        "signed_out",
        "session_reset",
        "harness_changed",
        "unsupported_request",
      ])
      .optional(),
    offerFreshSession: z.boolean().optional(),
    resetsAt: z.number().int().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

export interface TranscriptPage {
  tabId: string;
  entries: TranscriptEntry[];
  // Pass as `beforeSeq` to load older entries; null when the start is reached.
  nextSeq: number | null;
}
export interface TranscriptBatch {
  roomId: string;
  tabId: string;
  entries: TranscriptEntry[];
}

export interface HarnessModel {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort: string | null;
  isDefault: boolean;
  // Left out of the model picker by the host; a tab already on it keeps it.
  hidden?: boolean;
}
/** A model server on this computer that OpenCode tabs can use. */
export interface LocalServer {
  id: "ollama" | "lmstudio";
  label: string;
  running: boolean;
  // Why the server is not checked, such as OLLAMA_HOST pointing at another machine.
  note?: string;
  models: {
    id: string;
    name: string;
    // The context the server actually serves, when known.
    context?: number;
    // Set when the served context is too small or unknown for agentic use.
    warning?: string;
    // The server did not say whether the model supports tools.
    unverified?: boolean;
  }[];
}
export interface HarnessState {
  id: HarnessId;
  label: string;
  program: {
    state:
      | "unknown"
      | "missing"
      | "downloading"
      | "ready"
      | "failed"
      | "custom"
      | "custom_invalid"
      | "unsupported";
    version: string | null;
    pinned: string;
    progress?: number;
    customPath?: string;
    message?: string;
    warning?: string;
  };
  auth: {
    state: "unknown" | "checking" | "signed_in" | "signed_out" | "signing_in";
    account?: string;
    plan?: string;
    message?: string;
    // A copy-ready terminal command that signs this harness in (OpenCode hosted providers).
    command?: string;
    // Linked host config that overrides the app's login, naming the setting, never its value.
    warning?: string;
    // Whether the app holds a login it can sign out of.
    signOut?: boolean;
  };
  signIn: "in_app" | "guidance" | "command";
  // The newest published version of the program, when the check has answered.
  latestVersion?: string;
  // A newer version outside the line this app updates within, installable after an app update.
  laterVersion?: string;
  // The version this app ships with, when the managed program was updated past it.
  bundledVersion?: string;
  models: HarnessModel[];
  // Claude Code's output styles, and the one the host chose for new sessions.
  outputStyles?: string[];
  outputStyle?: string;
  modelsRefreshedAt: string | null;
  limits: { name: string; usedPercent: number; resetsAt: number | null }[];
  // Whether the harness reports its sub-agents.
  reportsAgents: boolean;
  // OpenCode's view of Ollama and LM Studio on this computer.
  localServers?: LocalServer[];
  // A harness with a notice (Claude Code's login policy) shows it once until acknowledged.
  noticePending: boolean;
}

/** A slash command or skill the harness runs when a prompt starts with `/name`. */
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

const tabRef = { roomId: id, tabId: id };
const answerValues = z.array(z.string().max(4_000)).max(20);

export const tabCommandSchemas = [
  z
    .object({
      type: z.literal("tab.open"),
      roomId: id,
      harness: harnessIdSchema,
      title: z.string().trim().min(1).max(80).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tab.rename"),
      ...tabRef,
      title: z.string().trim().min(1).max(80),
    })
    .strict(),
  z
    .object({
      type: z.literal("tab.close"),
      ...tabRef,
      confirm: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tab.setLoadout"),
      ...tabRef,
      loadout: loadoutSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("tab.send"),
      ...tabRef,
      text: z.string().trim().min(1).max(8_000),
      suggestionId: id.optional(),
      suggestionRevision: z.number().int().positive().optional(),
      continuePlan: z.literal(true).optional(),
    })
    .strict(),
  z.object({ type: z.literal("tab.stop"), ...tabRef }).strict(),
  // Reopens a closed tab with its transcript and harness session.
  z.object({ type: z.literal("tab.reopen"), ...tabRef }).strict(),
  // Permanently deletes a closed tab and its transcript.
  z.object({ type: z.literal("tab.delete"), ...tabRef }).strict(),
  z
    .object({
      type: z.literal("tab.transcript"),
      ...tabRef,
      beforeSeq: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      // Pages one sub-agent's entries instead of the lead's.
      agentKey: agentKey.optional(),
      // Pages the lead's entries after this seq, oldest first, instead of before `beforeSeq`.
      afterSeq: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tab.setReadAlong"),
      ...tabRef,
      on: z.boolean(),
      // Stops without the paused notice and closes the open window where it began, so entries
      // not yet published never publish (used when the host lost room membership).
      discard: z.literal(true).optional(),
    })
    .strict(),
  // Every sub-agent card of the tab, in the transcript result.
  z.object({ type: z.literal("tab.agents"), ...tabRef }).strict(),
  // The slash commands and skills the tab's harness offers, in the result's `commands`.
  z.object({ type: z.literal("tab.commands"), ...tabRef }).strict(),
  z.object({ type: z.literal("tab.resetSession"), ...tabRef }).strict(),
  z
    .object({
      type: z.literal("question.answer"),
      ...tabRef,
      questionId: id,
      answers: z.record(z.string().max(200), answerValues),
    })
    .strict(),
  z
    .object({ type: z.literal("harness.refresh"), harness: harnessIdSchema })
    .strict(),
  z
    .object({ type: z.literal("harness.signIn"), harness: harnessIdSchema })
    .strict(),
  z
    .object({
      type: z.literal("harness.cancelSignIn"),
      harness: harnessIdSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("harness.signOut"), harness: harnessIdSchema })
    .strict(),
  // Main opens a native file dialog; the renderer never supplies a path.
  z
    .object({
      type: z.literal("harness.chooseExecutable"),
      harness: harnessIdSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("harness.useManaged"), harness: harnessIdSchema })
    .strict(),
  z
    .object({
      type: z.literal("harness.acknowledgeNotice"),
      harness: harnessIdSchema,
    })
    .strict(),
  // Moves the managed program to the newest published version, or back to the bundled one.
  z
    .object({ type: z.literal("harness.update"), harness: harnessIdSchema })
    .strict(),
  z
    .object({
      type: z.literal("harness.revertUpdate"),
      harness: harnessIdSchema,
    })
    .strict(),
  // The model new tabs start on, and the effort that model starts at.
  z
    .object({
      type: z.literal("harness.setDefault"),
      harness: harnessIdSchema,
      model: z.string().min(1).max(120),
      effort,
    })
    .strict(),
  // The harness new tabs open with from the keyboard.
  z
    .object({
      type: z.literal("harness.setNewTab"),
      harness: harnessIdSchema,
    })
    .strict(),
  // Shows or hides a model in the tab model picker.
  z
    .object({
      type: z.literal("harness.setModelHidden"),
      harness: harnessIdSchema,
      model: z.string().min(1).max(120),
      hidden: z.boolean(),
    })
    .strict(),
  // The output style new sessions start with; null returns to the harness's own.
  z
    .object({
      type: z.literal("harness.setOutputStyle"),
      harness: harnessIdSchema,
      style: z.string().min(1).max(120).nullable(),
    })
    .strict(),
] as const;

export const DEFAULT_LOADOUT = (harness: HarnessId): Loadout => ({
  harness,
  model: "",
  planMode: false,
  access: "ask",
});

export type ReadAlongWindow = Tab["readAlongWindows"][number];
export const inReadAlongWindow = (windows: ReadAlongWindow[], seq: number) =>
  windows.some(
    (window) =>
      window.onSeq <= seq && (window.offSeq === null || seq < window.offSeq),
  );

export const tabBusy = (status: TabStatus) =>
  status === "running" || status === "awaiting_host";

export type ApprovalDecision = "accept" | "decline";
export type QuestionAnswers = Record<string, z.infer<typeof answerValues>>;
// A sub-agent card entry, with its card present.
export type AgentEntry = TranscriptEntry & { agent: AgentCard };

/** Whether a dotted version is newer than another, comparing number by number. */
export function newerVersion(candidate: string, current: string) {
  const parts = (version: string) => version.split(".").map(Number);
  const [a, b] = [parts(candidate), parts(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference > 0;
  }
  return false;
}
