import { startRunRequestSchema } from "@multiplayer-ai/domain";
import {
    createScriptedRunModel,
    resumeRun,
    startRun,
    type RunDeps,
} from "@multiplayer-ai/orchestration";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { search } from "@/features/runs/server/runAdapters";
import { createRunEventSink } from "@/features/runs/server/runEventSink";
import { getRunStore } from "@/features/runs/server/runStore";
import type { RunUIMessage } from "@/features/runs/types/runMessage";

export const runtime = "nodejs";
// Max duration for web; depends on Vercel Plan; increase for tool/app
export const maxDuration = 300;

export async function POST(request: Request) {
    const parsed = startRunRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
        return Response.json({ error: parsed.error.message }, { status: 400 });
    }
    const { roomId, goal, model, effort, resumeOf } = parsed.data;

    const aiMode = process.env.AI_MODE?.trim().toLowerCase();
    const isMock = aiMode === "mock";
    const modelOverride = isMock ? createScriptedRunModel() : undefined;

    const store = getRunStore();
    if (resumeOf && !(await store.load(resumeOf))) {
        return Response.json(
            {
                error:
                    "Unknown run (in-memory store; resume only works within the current process lifetime).",
            },
            { status: 404 },
        );
    }

    const runId = resumeOf ?? crypto.randomUUID();

    const stream = createUIMessageStream<RunUIMessage>({
        execute: async ({ writer }) => {
            writer.write({ type: "start" });
            const deps: RunDeps = {
                search,
                sink: createRunEventSink(writer),
                store,
                abortSignal: request.signal,
                modelOverride,
            };
            try {
                if (resumeOf) {
                    await resumeRun(resumeOf, deps);
                } else {
                    await startRun({ runId, roomId, goal, model, effort }, deps);
                }
            } catch (error) {
                if (!request.signal.aborted) {
                    console.error(`[run ${runId}]`, error);
                }
            }
            writer.write({ type: "finish" });
        },
        onError: () => "Run stream error",
    });

    return createUIMessageStreamResponse({
        stream,
        headers: { "x-ai-mode": isMock ? "mock" : model },
    });
}
