import type {
    RunMessageAuthor,
    RunRefusal,
    RunStatus,
    RunUIMessage,
} from "@multiplayer-ai/domain";
import { startRunRequestSchema } from "@multiplayer-ai/domain";
import { runTurn, type RunDeps } from "@multiplayer-ai/orchestration";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { z } from "zod";
import { claimRun } from "@/features/runs/lock";
import { search } from "@/features/runs/server/runAdapters";
import { createRunEventSink } from "@/features/runs/server/runEventSink";
import { getRunActor } from "@/features/runs/server/runActor";
import { runRuntime } from "@/features/runs/server/runRuntime";
import { openRunThread } from "@/features/runs/server/runThread";

export const runtime = "nodejs";
// Max duration for web; depends on Vercel Plan; increase for tool/app
export const maxDuration = 300;

const threadQuerySchema = z.object({
    roomId: z.uuid(),
    from: z.coerce.number().int().nonnegative().default(0),
});

const retireQuerySchema = z.object({ roomId: z.uuid() });

function runInProgress(runBy: RunMessageAuthor | null): Response {
    return Response.json(
        { error: "A run is already in progress", runBy } satisfies RunRefusal,
        { status: 409 },
    );
}

function withActor(
    handler: (request: Request, actor: RunMessageAuthor) => Promise<Response>,
) {
    return async function handle(request: Request): Promise<Response> {
        const actor = await getRunActor();
        if (actor === null) {
            return Response.json({ error: "Not authenticated" }, { status: 401 });
        }
        return handler(request, actor);
    };
}

export const POST = withActor(async (request, actor) => {
    const parsed = startRunRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
        return Response.json({ error: parsed.error.message }, { status: 400 });
    }
    const { roomId, goal, model, effort, userMessageId } = parsed.data;

    const store = runRuntime.store();

    const lock = await claimRun(store, roomId, actor);
    if (!lock.acquired) return runInProgress(lock.runBy);
    const threadId = lock.threadId;

    const broadcaster = runRuntime.broadcaster(roomId);
    const thread = openRunThread(store, broadcaster, threadId, actor);
    let seedMessages: Array<RunUIMessage>;
    try {
        const userMessage: RunUIMessage = {
            id: userMessageId ?? crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text: goal }],
            metadata: { author: actor },
        };
        seedMessages = [...lock.messages, userMessage];
        await thread.publish(userMessage);
    } catch (error) {
        await thread.finish("failed");
        console.error(`[run ${roomId}]`, error);
        return Response.json({ error: "Could not start the run" }, { status: 500 });
    }

    const runId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    let status: RunStatus = "running";

    const stream = createUIMessageStream<RunUIMessage>({
        execute: async ({ writer }) => {
            writer.write({ type: "start", messageId: assistantMessageId });
            const { sink, settled } = createRunEventSink(writer, {
                assistantMessageId,
                persist: (message) => thread.publish(message),
            });
            const deps: RunDeps = {
                search,
                sink,
                abortSignal: request.signal,
                modelOverride: runRuntime.modelOverride(),
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
            await settled();
            writer.write({ type: "finish" });
        },
        originalMessages: seedMessages,
        onEnd: () => thread.finish(status),
        onError: () => "Run stream error",
    });

    return createUIMessageStreamResponse({
        stream,
        headers: { "x-ai-mode": runRuntime.describe(model) },
    });
});

export const GET = withActor(async (request, actor) => {
    const url = new URL(request.url);
    const parsed = threadQuerySchema.safeParse({
        roomId: url.searchParams.get("roomId"),
        from: url.searchParams.get("from") ?? 0,
    });
    if (!parsed.success) {
        return Response.json({ error: "Invalid query" }, { status: 400 });
    }

    const { threadId, status, runBy, messages } = await runRuntime.store().loadFrom(
        parsed.data.roomId,
        actor,
        parsed.data.from,
    );

    return Response.json({ threadId, status, runBy, messages });
});

export const DELETE = withActor(async (request, actor) => {
    const url = new URL(request.url);
    const parsed = retireQuerySchema.safeParse({
        roomId: url.searchParams.get("roomId"),
    });
    if (!parsed.success) {
        return Response.json({ error: "Invalid roomId" }, { status: 400 });
    }
    const { roomId } = parsed.data;

    const result = await runRuntime.store().retire(roomId, actor);
    if (!result.retired) return runInProgress(result.runBy);

    const broadcaster = runRuntime.broadcaster(roomId);
    await broadcaster.send({
        kind: "retired",
        threadId: result.threadId,
        retiredThreadId: result.retiredThreadId,
    });
    await broadcaster.close();

    return Response.json({
        retiredThreadId: result.retiredThreadId,
        threadId: result.threadId,
    });
});
