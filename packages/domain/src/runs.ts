import { z } from "zod";

export const modelKeys = [
    "openai:gpt-5-mini",
    "openai:gpt-5",
    "google:gemini-3.6-flash",
    "google:gemini-3.5-flash-lite",
] as const;

export type ModelKey = (typeof modelKeys)[number];

export function isModelKey(value: unknown): value is ModelKey {
    return (
        typeof value === "string" &&
        (modelKeys as readonly string[]).includes(value)
    );
}

export type ModelProvider = "openai" | "google";

type ModelInfo = {
    provider: ModelProvider;
    contextWindow: number;
};

const MODEL_INFO: Record<ModelKey, ModelInfo> = {
    "openai:gpt-5-mini": { provider: "openai", contextWindow: 400_000 },
    "openai:gpt-5": { provider: "openai", contextWindow: 400_000 },
    "google:gemini-3.6-flash": { provider: "google", contextWindow: 1_048_576 },
    "google:gemini-3.5-flash-lite": {
        provider: "google",
        contextWindow: 1_048_576,
    },
};

export function getContextWindow(key: ModelKey): number {
    return MODEL_INFO[key].contextWindow;
}

export function getModelProvider(key: ModelKey): ModelProvider {
    return MODEL_INFO[key].provider;
}

export const effortLevels = ["low", "med", "high"] as const;

export type EffortLevel = (typeof effortLevels)[number];

export const runStatuses = [
    "running",
    "finished",
    "cancelled",
    "failed",
] as const;

export type RunStatus = (typeof runStatuses)[number];

export type PersonaId = "lead" | "scout";

export type RunEvent =
    | { kind: "run.started"; runId: string; goal: string; model: ModelKey }
    | { kind: "run.tool"; runId: string; tool: string; ms: number; ok: boolean }
    | { kind: "run.delegated"; runId: string; persona: PersonaId; task: string }
    | {
          kind: "run.delegate.done";
          runId: string;
          persona: PersonaId;
          ms: number;
          summary: string;
          confidence: string;
      }
    | {
          kind: "run.delegate.failed";
          runId: string;
          persona: PersonaId;
          ms: number;
          error: string;
      }
    | { kind: "run.verify"; runId: string; ok: boolean; issues: Array<string> }
    | { kind: "run.no_action"; runId: string; reason: string }
    | { kind: "run.compacted"; runId: string }
    | { kind: "run.finished"; runId: string; text: string }
    | { kind: "run.cancelled"; runId: string }
    | { kind: "run.failed"; runId: string; error: string };

export type RunDataTypes = {
    [K in RunEvent["kind"]]: Extract<RunEvent, { kind: K }>;
};

export const ScoutBrief = z.object({
    summary: z.string().max(1200),
    findings: z
        .array(z.object({ claim: z.string(), source: z.string() }))
        .max(10),
    confidence: z.enum(["low", "medium", "high"]),
    gaps: z.array(z.string()).max(5),
});
export type ScoutBrief = z.infer<typeof ScoutBrief>;

export const Verdict = z.object({
    ok: z.boolean(),
    issues: z.array(z.string()).max(5),
});
export type Verdict = z.infer<typeof Verdict>;

export type SearchResult = { title: string; url: string; snippet: string };

export type SearchOptions = {
    maxResults: number;
    searchDepth: "basic" | "advanced";
    abortSignal?: AbortSignal;
};

export type SearchFn = (
    query: string,
    options: SearchOptions,
) => Promise<Array<SearchResult>>;

export const startRunRequestSchema = z.object({
    roomId: z.uuid(),
    goal: z.string().trim().min(1).max(4_000),
    model: z.enum(modelKeys),
    effort: z.enum(effortLevels).optional(),
    userMessageId: z.uuid().optional(),
});
export type StartRunRequest = z.infer<typeof startRunRequestSchema>;

/** Realtime topic for a room's AI thread. The second segment is what the membership policy reads. */
export function runThreadTopic(roomId: string): string {
    return `room:${roomId}:ai`;
}

export const RUN_THREAD_EVENT = "thread";

const runMessageAuthorSchema = z.object({
    id: z.uuid(),
    name: z.string().min(1),
});

const runThreadEventSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("progress"),
        threadId: z.uuid(),
        status: z.enum(runStatuses),
        runBy: runMessageAuthorSchema.nullable(),
        seq: z.number().int().positive(),
    }),
    z.object({
        kind: z.literal("status"),
        threadId: z.uuid(),
        status: z.enum(runStatuses),
        runBy: runMessageAuthorSchema.nullable(),
    }),
    z.object({
        kind: z.literal("retired"),
        threadId: z.uuid(),
        retiredThreadId: z.uuid(),
    }),
]);

export type RunThreadEvent = z.infer<typeof runThreadEventSchema>;

export function parseRunThreadEvent(payload: unknown): RunThreadEvent | null {
    const result = runThreadEventSchema.safeParse(payload);
    return result.success ? result.data : null;
}

export const runRefusalSchema = z.object({
    error: z.string(),
    runBy: runMessageAuthorSchema.nullable(),
});
export type RunRefusal = z.infer<typeof runRefusalSchema>;

export function refusalNotice(payload: unknown, fallback: string): string {
    const parsed = runRefusalSchema.safeParse(payload);
    if (!parsed.success) return fallback;

    const { error, runBy } = parsed.data;
    return runBy === null ? error : `${runBy.name} is already running the agent.`;
}
