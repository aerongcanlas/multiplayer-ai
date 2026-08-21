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
    | { kind: "run.finished"; runId: string; text: string }
    | { kind: "run.cancelled"; runId: string }
    | { kind: "run.failed"; runId: string; error: string };

export type RunDataTypes = {
    [K in RunEvent["kind"]]: Extract<RunEvent, { kind: K }>;
};

/** What a subagent is allowed to hand back. Capped so summarization is forced. */
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
    resumeOf: z.uuid().optional(),
});
export type StartRunRequest = z.infer<typeof startRunRequestSchema>;
