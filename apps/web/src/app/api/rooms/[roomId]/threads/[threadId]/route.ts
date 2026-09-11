import { createThreadDetailHandlers } from "@/features/threads/server/threadDetailRoute";

const handlers = createThreadDetailHandlers();

type RouteContext = {
    params: Promise<{ roomId: string; threadId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
    return handlers.GET(request, context);
}

export async function PATCH(request: Request, context: RouteContext) {
    return handlers.PATCH(request, context);
}
