"use client";

import { Chat, useChat } from "@ai-sdk/react";
import type {
    ModelKey,
    RunMessageAuthor,
    RunStatus,
    RunUIMessage,
} from "@multiplayer-ai/domain";
import { refusalNotice } from "@multiplayer-ai/domain";
import { selectionFromLocation } from "@/features/threads/components/RoomThreadNavigation/threadNavigationState";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
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
        const explicit =
            typeof window === "undefined"
                ? undefined
                : selectionFromLocation(window.location.href, roomId);
        const selected =
            explicit ?? registry.selected(roomId) ?? initialThreadId;
        return { initialThreadId, activeThreadId: selected };
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
    useSyncExternalStore(
        registry.subscribe,
        registry.snapshot,
        registry.snapshot,
    );
    const activeThreadId =
        selection.initialThreadId === initialThreadId
            ? selection.activeThreadId
            : initialThreadId;
    const session = useThreadSession(roomId, activeThreadId);
    const { messages, sendMessage, stop, status, error, clearError } =
        useChat<RunUIMessage>({ chat: session.chat as Chat<RunUIMessage> });

    useEffect(() => {
        const sync = () => {
            if (window.location.pathname.split("/")[2] !== roomId) return;
            const threadId =
                selectionFromLocation(window.location.href, roomId) ??
                window.history.state?.roomThreadSelection ??
                initialThreadId;
            registry.select(roomId, threadId);
            setSelection({ initialThreadId, activeThreadId: threadId });
        };
        // Seed the entry so Back to a local fresh draft restores that exact session.
        if (selectionFromLocation(window.location.href, roomId) === undefined) {
            window.history.replaceState(
                {
                    ...window.history.state,
                    roomThreadSelection: activeThreadId,
                },
                "",
            );
        }
        window.addEventListener("popstate", sync);
        const unsubscribe = registry.subscribe(() => {
            const threadId = registry.selected(roomId);
            if (threadId !== undefined)
                setSelection((previous) =>
                    previous.activeThreadId === threadId
                        ? previous
                        : { initialThreadId, activeThreadId: threadId },
                );
        });
        return () => {
            window.removeEventListener("popstate", sync);
            unsubscribe();
        };
    }, [activeThreadId, initialThreadId, registry, roomId]);

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
                    const url = new URL(window.location.href);
                    if (url.pathname.split("/")[2] === roomId) {
                        url.searchParams.set("thread", requestThreadId);
                        window.history.replaceState(
                            window.history.state,
                            "",
                            url,
                        );
                    }
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

    const newThread = useCallback(() => {
        registry.setRequestError(roomId, activeThreadId, null);
        const localThreadId = crypto.randomUUID();
        registry.hydrate(roomId, localThreadId, {
            messages: [],
            durable: false,
        });
        registry.select(roomId, localThreadId);
        reconciler.clearSelection();
        const url = new URL(window.location.href);
        url.searchParams.delete("thread");
        window.history.pushState(
            { roomThreadSelection: localThreadId },
            "",
            url,
        );
        setSelection({ initialThreadId, activeThreadId: localThreadId });
    }, [activeThreadId, initialThreadId, reconciler, registry, roomId]);

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

    const retryHistory = useCallback(() => {
        if (session.state.durable) {
            void reconciler.refresh(roomId, activeThreadId);
        }
    }, [activeThreadId, reconciler, roomId, session.state.durable]);

    return {
        activeThreadId,
        messages,
        startRun,
        newThread,
        stop,
        status,
        threadStatus: session.state.status,
        runBy: session.state.runBy,
        threadRetired: session.state.retired,
        isConnected: session.state.syncError === null,
        loadState: session.state.loadState,
        historyError:
            session.state.loadState === "loaded"
                ? null
                : session.state.syncError,
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
        retryHistory,
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
