"use client";

import { Chat, useChat } from "@ai-sdk/react";
import type {
    ModelKey,
    RunMessageAuthor,
    RunStatus,
    RunUIMessage,
} from "@multiplayer-ai/domain";
import { refusalNotice } from "@multiplayer-ai/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    useThreadSession,
    useThreadSessionContext,
} from "@/features/threads/session/ThreadSessionProvider";

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

interface Options {
    roomId: string;
    currentUser: RunMessageAuthor;
    initialThreadId: string;
    initialMessages?: Array<RunUIMessage>;
    initialStatus?: RunStatus;
    initialRunBy?: RunMessageAuthor | null;
    initialSeq?: number;
    initialThreadDurable?: boolean;
}

export function useRoomRun({
    roomId,
    currentUser,
    initialThreadId,
    initialMessages,
    initialStatus = "finished",
    initialRunBy = null,
    initialSeq = 0,
    initialThreadDurable = true,
}: Options) {
    const { registry, reconciler, observeRoom } = useThreadSessionContext();
    const [selection, setSelection] = useState(() => {
        registry.hydrate(roomId, initialThreadId, {
            messages: initialMessages,
            status: initialStatus,
            runBy: initialRunBy,
            seq: initialSeq,
            durable: initialThreadDurable,
        });
        return { initialThreadId, activeThreadId: initialThreadId };
    });
    if (selection.initialThreadId !== initialThreadId) {
        registry.hydrate(roomId, initialThreadId, {
            messages: initialMessages,
            status: initialStatus,
            runBy: initialRunBy,
            seq: initialSeq,
            durable: initialThreadDurable,
        });
        setSelection({ initialThreadId, activeThreadId: initialThreadId });
    }
    const activeThreadId =
        selection.initialThreadId === initialThreadId
            ? selection.activeThreadId
            : initialThreadId;
    const session = useThreadSession(roomId, activeThreadId);
    const { messages, sendMessage, stop, status, error, clearError } =
        useChat<RunUIMessage>({ chat: session.chat as Chat<RunUIMessage> });
    const pendingCreationIdRef = useRef<string | null>(null);

    useEffect(() => {
        registry.select(roomId, activeThreadId);
        if (session.state.durable) reconciler.select(roomId, activeThreadId);
        else reconciler.clearSelection();
    }, [activeThreadId, reconciler, registry, roomId, session.state.durable]);

    useEffect(() => observeRoom(roomId), [observeRoom, roomId]);

    const streamingHere = status === "submitted" || status === "streaming";
    useEffect(() => {
        if (!session.state.durable) return;
        reconciler.setRunning(roomId, activeThreadId, streamingHere);
        if (!streamingHere) void reconciler.refresh(roomId, activeThreadId);
    }, [
        activeThreadId,
        reconciler,
        roomId,
        session.state.durable,
        streamingHere,
    ]);

    const startRun = useCallback(
        async (goal: string) => {
            registry.setRequestError(roomId, activeThreadId, null);
            const userMessageId = registry.prepareSubmission(
                roomId,
                activeThreadId,
                goal,
            );
            let requestThreadId = activeThreadId;
            try {
                let targetSendMessage = sendMessage;
                if (!session.state.durable) {
                    requestThreadId = await createDurableThread(
                        roomId,
                        activeThreadId,
                    );
                    registry.promoteLocal(
                        roomId,
                        activeThreadId,
                        requestThreadId,
                    );
                    registry.select(roomId, requestThreadId);
                    setSelection({
                        initialThreadId,
                        activeThreadId: requestThreadId,
                    });
                    targetSendMessage = (
                        registry.ensure(roomId, requestThreadId)
                            .chat as Chat<RunUIMessage>
                    ).sendMessage;
                }
                await targetSendMessage(
                    {
                        id: userMessageId,
                        role: "user",
                        parts: [{ type: "text", text: goal }],
                        metadata: { author: currentUser },
                    },
                    {
                        body: {
                            roomId,
                            threadId: requestThreadId,
                            prompt: goal,
                            model: session.state.model,
                            userMessageId,
                        },
                    },
                );
                void reconciler.refresh(roomId, requestThreadId);
            } catch (requestError) {
                registry.setRequestError(
                    roomId,
                    requestThreadId,
                    requestError instanceof Error
                        ? refusalNotice(
                              safeJson(requestError.message),
                              requestError.message,
                          )
                        : "Could not start the run.",
                );
                throw requestError;
            }
        },
        [
            activeThreadId,
            currentUser,
            initialThreadId,
            reconciler,
            registry,
            roomId,
            sendMessage,
            session.state.durable,
            session.state.model,
        ],
    );

    const newThread = useCallback(async () => {
        registry.setRequestError(roomId, activeThreadId, null);
        let body: unknown;
        const creationId = pendingCreationIdRef.current ?? crypto.randomUUID();
        pendingCreationIdRef.current = creationId;
        try {
            const response = await fetch(`/api/rooms/${roomId}/threads`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ creationId }),
            });
            body = await response.json();
            if (!response.ok) {
                registry.setRequestError(
                    roomId,
                    activeThreadId,
                    refusalNotice(body, "Could not start a new thread."),
                );
                return;
            }
        } catch {
            registry.setRequestError(
                roomId,
                activeThreadId,
                "Could not start a new thread.",
            );
            return;
        }
        const { thread } = body as { thread?: { id?: unknown } };
        if (typeof thread?.id !== "string") {
            registry.setRequestError(
                roomId,
                activeThreadId,
                "Could not start a new thread.",
            );
            return;
        }
        pendingCreationIdRef.current = null;
        registry.hydrate(roomId, thread.id, { messages: [], durable: true });
        registry.select(roomId, thread.id);
        setSelection({ initialThreadId, activeThreadId: thread.id });
    }, [activeThreadId, initialThreadId, registry, roomId]);

    const dismissNotice = useCallback(() => {
        registry.setRequestError(roomId, activeThreadId, null);
        registry.setSyncError(roomId, activeThreadId, null);
        clearError();
    }, [activeThreadId, clearError, registry, roomId]);

    const setModel = useCallback(
        (model: ModelKey) => registry.setModel(roomId, activeThreadId, model),
        [activeThreadId, registry, roomId],
    );

    const notice =
        session.state.requestError ??
        session.state.syncError ??
        (error === undefined
            ? null
            : refusalNotice(safeJson(error.message), error.message));

    return {
        messages,
        startRun,
        newThread,
        stop,
        status,
        threadStatus: session.state.status,
        runBy: session.state.runBy,
        threadRetired: session.state.retired,
        isConnected: session.state.syncError === null,
        notice,
        dismissNotice,
        model: session.state.model,
        setModel,
        draft: session.state.draft,
        draftRevision: session.state.draftRevision,
        setDraft: (draft: string) =>
            registry.setDraft(roomId, activeThreadId, draft),
        clearAcceptedDraft: (revision: number) =>
            registry.clearAcceptedDraft(roomId, activeThreadId, revision),
    };
}

async function createDurableThread(roomId: string, creationId: string) {
    const response = await fetch(`/api/rooms/${roomId}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creationId }),
    });
    const body = (await response.json()) as {
        thread?: { id?: unknown };
        error?: unknown;
    };
    if (!response.ok || typeof body.thread?.id !== "string") {
        throw new Error(
            typeof body.error === "string"
                ? body.error
                : "Could not create the thread.",
        );
    }
    return body.thread.id;
}
