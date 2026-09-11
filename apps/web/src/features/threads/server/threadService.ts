import {
    decodeThreadCursor,
    threadSummarySchema,
    type ThreadPage,
    type ThreadSummary,
    type UpdateThreadRequest,
} from "@multiplayer-ai/domain";
import {
    createThreadStore,
    ThreadStoreError,
    type ThreadRecord,
    type ThreadStore,
} from "./threadStore";

export type ThreadServiceErrorCode =
    | "not_found"
    | "unauthenticated"
    | "invalid"
    | "busy"
    | "archived"
    | "database";

export class ThreadServiceError extends Error {
    readonly code: ThreadServiceErrorCode;
    readonly status: number;

    constructor(
        code: ThreadServiceErrorCode,
        message: string,
        status?: number,
    ) {
        super(message);
        this.name = "ThreadServiceError";
        this.code = code;
        this.status =
            status ??
            (code === "not_found"
                ? 404
                : code === "busy" || code === "archived"
                  ? 409
                  : 400);
    }
}

function mapError(error: unknown): ThreadServiceError {
    if (error instanceof ThreadServiceError) return error;
    const code =
        error instanceof ThreadStoreError
            ? error.code
            : typeof error === "object" && error !== null && "code" in error
              ? String((error as { code?: unknown }).code)
              : "database";
    if (code === "55P03")
        return new ThreadServiceError("busy", "Thread has an active run");
    if (code === "P0001")
        return new ThreadServiceError("archived", "Thread is archived");
    if (code === "42501" || code === "not_member" || code === "P0002") {
        return new ThreadServiceError("not_found", "Thread not found", 404);
    }
    if (code === "invalid_cursor" || code === "22023") {
        return new ThreadServiceError("invalid", "Invalid thread request", 400);
    }
    return new ThreadServiceError("database", "Could not access thread", 500);
}

export function createThreadService(store: ThreadStore = createThreadStore()) {
    async function list(input: {
        roomId: string;
        actorId: string;
        archived?: boolean;
        cursor?: string;
        limit?: number;
    }): Promise<ThreadPage> {
        if (
            input.cursor !== undefined &&
            decodeThreadCursor(input.cursor) === null
        ) {
            throw new ThreadServiceError(
                "invalid",
                "Invalid thread cursor",
                400,
            );
        }
        try {
            const page = store.listPage
                ? await store.listPage(input.roomId, input.actorId, input)
                : {
                      threads: await store.list(
                          input.roomId,
                          input.actorId,
                          input,
                      ),
                      nextCursor: null,
                  };
            return {
                threads: page.threads.map((thread) =>
                    threadSummarySchema.parse(thread),
                ),
                nextCursor: page.nextCursor,
            };
        } catch (error) {
            throw mapError(error);
        }
    }

    async function get(
        roomId: string,
        threadId: string,
        actorId: string,
    ): Promise<ThreadRecord> {
        try {
            return await store.get(roomId, threadId, actorId);
        } catch (error) {
            throw mapError(error);
        }
    }

    async function history(
        roomId: string,
        threadId: string,
        actorId: string,
        fromSeq = 0,
    ): Promise<ThreadRecord> {
        if (!Number.isInteger(fromSeq) || fromSeq < 0) {
            throw new ThreadServiceError(
                "invalid",
                "Invalid history cursor",
                400,
            );
        }
        const thread = await get(roomId, threadId, actorId);
        return {
            ...thread,
            messages: thread.messages.filter(
                (message) => message.seq >= fromSeq,
            ),
        };
    }

    async function create(
        roomId: string,
        actorId: string,
        creationId: string,
    ): Promise<ThreadSummary> {
        try {
            return threadSummarySchema.parse(
                await store.create(roomId, actorId, creationId),
            );
        } catch (error) {
            throw mapError(error);
        }
    }

    async function update(
        roomId: string,
        threadId: string,
        actorId: string,
        action: UpdateThreadRequest,
    ): Promise<ThreadSummary> {
        try {
            if (action.action === "rename")
                await store.rename(roomId, threadId, actorId, action.title);
            else if (action.action === "archive")
                await store.archive(roomId, threadId, actorId);
            else await store.restore(roomId, threadId, actorId);
            return await store
                .get(roomId, threadId, actorId)
                .then((thread) => threadSummarySchema.parse(thread));
        } catch (error) {
            throw mapError(error);
        }
    }

    return { list, get, history, create, update };
}

export type ThreadService = ReturnType<typeof createThreadService>;

export function threadErrorResponse(error: unknown): Response {
    const mapped = mapError(error);
    return Response.json(
        { error: mapped.message, code: mapped.code },
        { status: mapped.status },
    );
}
