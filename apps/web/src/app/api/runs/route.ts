import type { RunStatus } from "@multiplayer-ai/domain";
import { startRunRequestSchema } from "@multiplayer-ai/domain";
import {
    createScriptedRunModel,
    runTurn,
    type RunDeps,
} from "@multiplayer-ai/orchestration";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { z } from "zod";
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
    const { roomId, goal, model, effort } = parsed.data;

    const aiMode = process.env.AI_MODE?.trim().toLowerCase();
    const isMock = aiMode === "mock";
    const modelOverride = isMock ? createScriptedRunModel() : undefined;

    const store = getRunStore();
    const thread = await store.load(roomId);

    const userMessage: RunUIMessage = {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: goal }],
    };
    const seedMessages = [...thread.messages, userMessage];

    // Persisted before the run starts so the question survives a run that fails,
    // is cancelled, or a process crash outright — not just a normal thrown error.
    await store.save(roomId, { messages: seedMessages, status: "running" });

    const runId = crypto.randomUUID();
    let status: RunStatus = "running";

    const stream = createUIMessageStream<RunUIMessage>({
        execute: async ({ writer }) => {
            writer.write({ type: "start" });
            const deps: RunDeps = {
                search,
                sink: createRunEventSink(writer),
                abortSignal: request.signal,
                modelOverride,
            };
            try {
                await runTurn({ runId, roomId, goal, model, effort }, seedMessages, deps);
                status = "finished";
            } catch (error) {
                status = request.signal.aborted ? "cancelled" : "failed";
                if (!request.signal.aborted) {
                    console.error(`[run ${runId}]`, error);
                }
            }
            writer.write({ type: "finish" });
        },
        originalMessages: seedMessages,
        onEnd: async ({ messages }) => {
            await store.save(roomId, { messages, status });
        },
        onError: () => "Run stream error",
    });

    return createUIMessageStreamResponse({
        stream,
        headers: { "x-ai-mode": isMock ? "mock" : model },
    });
}

export async function DELETE(request: Request) {
    const roomId = new URL(request.url).searchParams.get("roomId");
    const parsed = z.uuid().safeParse(roomId);
    if (!parsed.success) {
        return Response.json({ error: "Invalid roomId" }, { status: 400 });
    }

    await getRunStore().clear(parsed.data);
    return new Response(null, { status: 204 });
}
