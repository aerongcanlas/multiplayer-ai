import { updateThreadRequestSchema } from "@multiplayer-ai/domain";
import { z } from "zod";
import { getRunActor } from "@/features/runs/server/runActor";
import {
    createThreadService,
    threadErrorResponse,
    type ThreadService,
} from "@/features/threads/server/threadService";

type RouteContext = { params: Promise<{ roomId: string; threadId: string }> };

type Dependencies = {
    getActor: typeof getRunActor;
    getService: () => ThreadService;
};

export function createThreadDetailHandlers(
    dependencies: Dependencies = {
        getActor: getRunActor,
        getService: createThreadService,
    },
) {
    async function GET(_request: Request, { params }: RouteContext) {
        const actor = await dependencies.getActor();
        if (actor === null) {
            return Response.json(
                { error: "Not authenticated" },
                { status: 401 },
            );
        }
        const { roomId, threadId } = await params;
        if (
            !z.uuid().safeParse(roomId).success ||
            !z.uuid().safeParse(threadId).success
        ) {
            return Response.json(
                { error: "Invalid thread id" },
                { status: 400 },
            );
        }
        try {
            return Response.json({
                thread: await dependencies
                    .getService()
                    .get(roomId, threadId, actor.id),
            });
        } catch (error) {
            return threadErrorResponse(error);
        }
    }

    async function PATCH(request: Request, { params }: RouteContext) {
        const actor = await dependencies.getActor();
        if (actor === null) {
            return Response.json(
                { error: "Not authenticated" },
                { status: 401 },
            );
        }
        const { roomId, threadId } = await params;
        if (
            !z.uuid().safeParse(roomId).success ||
            !z.uuid().safeParse(threadId).success
        ) {
            return Response.json(
                { error: "Invalid thread id" },
                { status: 400 },
            );
        }
        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
        const parsed = updateThreadRequestSchema.safeParse(body);
        if (!parsed.success) {
            return Response.json(
                { error: "Invalid thread update" },
                { status: 400 },
            );
        }
        try {
            return Response.json({
                thread: await dependencies
                    .getService()
                    .update(roomId, threadId, actor.id, parsed.data),
            });
        } catch (error) {
            return threadErrorResponse(error);
        }
    }

    return { GET, PATCH };
}

const handlers = createThreadDetailHandlers();
export const GET = handlers.GET;
export const PATCH = handlers.PATCH;
