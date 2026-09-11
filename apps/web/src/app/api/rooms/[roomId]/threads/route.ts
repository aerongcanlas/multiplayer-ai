import { createThreadCollectionHandlers } from "@/features/threads/server/threadCollectionRoute";

const handlers = createThreadCollectionHandlers();

export async function GET(
    request: Request,
    context: { params: Promise<{ roomId: string }> },
) {
    return handlers.GET(request, context);
}

export async function POST(
    request: Request,
    context: { params: Promise<{ roomId: string }> },
) {
    return handlers.POST(request, context);
}
