import type {
    RunMessageAuthor,
    RunRefusal,
    RunStatus,
    RunUIMessage,
} from "@multiplayer-ai/domain";
import { startRunRequestSchema } from "@multiplayer-ai/domain";
import {
    runTurn,
    type RunDeps,
    type RunStore,
} from "@multiplayer-ai/orchestration";
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
    threadId: z.uuid(),
    from: z.coerce.number().int().nonnegative().default(0),
});

function runInProgress(runBy: RunMessageAuthor | null): Response {
    return Response.json(
        { error: "A run is already in progress", runBy } satisfies RunRefusal,
        { status: 409 },
    );
}

export function runStoreFailure(error: unknown): Response {
    const code =
        typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code)
            : "";
    if (code === "55P03")
        return Response.json(
            { error: "A run is already in progress", code: "busy" },
            { status: 409 },
        );
    if (code === "P0001")
        return Response.json(
            { error: "Thread is archived", code: "archived" },
            { status: 409 },
        );
    if (
        code === "P0002" ||
        code === "42501" ||
        (error instanceof Error && error.message === "Thread not found")
    ) {
        return Response.json(
            { error: "Thread not found", code: "not_found" },
            { status: 404 },
        );
    }
    return Response.json({ error: "Could not access thread" }, { status: 500 });
}

export function withActor(
    handler: (request: Request, actor: RunMessageAuthor) => Promise<Response>,
    actorResolver: typeof getRunActor = getRunActor,
) {
    return async function handle(request: Request): Promise<Response> {
        const actor = await actorResolver();
        if (actor === null) {
            return Response.json(
                { error: "Not authenticated" },
                { status: 401 },
            );
        }
        return handler(request, actor);
    };
}

export const POST = withActor(async (request, actor) => {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = startRunRequestSchema.safeParse(body);
    if (!parsed.success) {
        return Response.json({ error: parsed.error.message }, { status: 400 });
    }
    const { roomId, threadId, prompt, model, effort, userMessageId } =
        parsed.data;

    const store = runRuntime.store();

    let lock: Awaited<ReturnType<typeof claimRun>>;
    try {
        lock = await claimRun(store, roomId, threadId, actor);
    } catch (error) {
        return runStoreFailure(error);
    }
    if (!lock.acquired) return runInProgress(lock.runBy);

    const broadcaster = runRuntime.broadcaster(roomId);
    const thread = openRunThread(store, broadcaster, threadId, actor);
    let seedMessages: Array<RunUIMessage>;
    try {
        const userMessage: RunUIMessage = {
            id: userMessageId,
            role: "user",
            parts: [{ type: "text", text: prompt }],
            metadata: { author: actor },
        };
        seedMessages = [...lock.messages, userMessage];
        await thread.publish(userMessage);
    } catch (error) {
        await thread.finish("failed");
        console.error(`[run ${roomId}]`, error);
        return Response.json(
            { error: "Could not start the run" },
            { status: 500 },
        );
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
                await runTurn(
                    { runId, roomId, threadId, goal: prompt, model, effort },
                    seedMessages,
                    deps,
                );
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
        threadId: url.searchParams.get("threadId"),
        from: url.searchParams.get("from") ?? 0,
    });
    if (!parsed.success) {
        return Response.json({ error: "Invalid query" }, { status: 400 });
    }

    let loaded: Awaited<ReturnType<RunStore["loadFrom"]>>;
    try {
        loaded = await runRuntime
            .store()
            .loadFrom(
                parsed.data.roomId,
                actor,
                parsed.data.threadId,
                parsed.data.from,
            );
    } catch (error) {
        return runStoreFailure(error);
    }
    const { threadId, status, runBy, messages } = loaded;

    return Response.json({ threadId, status, runBy, messages });
});

export const DELETE = withActor(async (request, actor) => {
    void request;
    void actor;
    return Response.json(
        { error: "Thread retirement is no longer supported" },
        { status: 410 },
    );
});
