import {
    createThreadRequestSchema,
    listThreadsQuerySchema,
} from "@multiplayer-ai/domain";
import { z } from "zod";
import { getRunActor } from "@/features/runs/server/runActor";
import {
    createThreadService,
    threadErrorResponse,
    type ThreadService,
} from "@/features/threads/server/threadService";

type RouteContext = { params: Promise<{ roomId: string }> };

type Dependencies = {
    getActor: typeof getRunActor;
    getService: () => ThreadService;
};

export function createThreadCollectionHandlers(
    dependencies: Dependencies = {
        getActor: getRunActor,
        getService: createThreadService,
    },
) {
    async function GET(request: Request, { params }: RouteContext) {
        const actor = await dependencies.getActor();
        if (actor === null) {
            return Response.json(
                { error: "Not authenticated" },
                { status: 401 },
            );
        }
        const { roomId } = await params;
        if (!z.uuid().safeParse(roomId).success) {
            return Response.json({ error: "Invalid room id" }, { status: 400 });
        }
        const url = new URL(request.url);
        const parsed = listThreadsQuerySchema.safeParse({
            archived: url.searchParams.get("archived") ?? "false",
            cursor: url.searchParams.get("cursor") ?? undefined,
            limit: url.searchParams.get("limit") ?? undefined,
        });
        if (!parsed.success) {
            return Response.json(
                { error: "Invalid thread query" },
                { status: 400 },
            );
        }
        try {
            return Response.json(
                await dependencies.getService().list({
                    roomId,
                    actorId: actor.id,
                    ...parsed.data,
                }),
            );
        } catch (error) {
            return threadErrorResponse(error);
        }
    }

    async function POST(request: Request, { params }: RouteContext) {
        const actor = await dependencies.getActor();
        if (actor === null) {
            return Response.json(
                { error: "Not authenticated" },
                { status: 401 },
            );
        }
        const { roomId } = await params;
        if (!z.uuid().safeParse(roomId).success) {
            return Response.json({ error: "Invalid room id" }, { status: 400 });
        }
        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
        const parsed = createThreadRequestSchema.safeParse(body);
        if (!parsed.success) {
            return Response.json(
                { error: "Invalid thread request" },
                { status: 400 },
            );
        }
        try {
            const thread = await dependencies
                .getService()
                .create(roomId, actor.id, parsed.data.creationId);
            return Response.json({ thread }, { status: 201 });
        } catch (error) {
            return threadErrorResponse(error);
        }
    }

    return { GET, POST };
}

const handlers = createThreadCollectionHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
