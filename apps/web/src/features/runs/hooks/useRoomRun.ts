"use client";

import { useChat } from "@ai-sdk/react";
import type {
    ModelKey,
    RunMessageAuthor,
    RunStatus,
    RunThreadEvent,
    RunUIMessage,
} from "@multiplayer-ai/domain";
import {
    RUN_THREAD_EVENT,
    parseRunThreadEvent,
    refusalNotice,
    runThreadTopic,
} from "@multiplayer-ai/domain";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const transport = new DefaultChatTransport<RunUIMessage>({ api: "/api/runs" });

const DISCONNECTED_POLL_MS = 5000;

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

type ThreadSnapshot = {
    threadId: string;
    status: RunStatus;
    runBy: RunMessageAuthor | null;
    messages: Array<{ seq: number; message: RunUIMessage }>;
};

type ThreadView = {
    threadId: string;
    lastSeq: number;
    status: RunStatus;
    runBy: RunMessageAuthor | null;
    retired: boolean;
};

interface Options {
    roomId: string;
    currentUser: RunMessageAuthor;
    initialThreadId: string;
    initialMessages?: Array<RunUIMessage>;
    initialStatus?: RunStatus;
    initialRunBy?: RunMessageAuthor | null;
    initialSeq?: number;
}

export function useRoomRun({
    roomId,
    currentUser,
    initialThreadId,
    initialMessages,
    initialStatus = "finished",
    initialRunBy = null,
    initialSeq = 0,
}: Options) {
    const supabase = useMemo(() => createClient(), []);
    const [model, setModel] = useState<ModelKey>("google:gemini-3.6-flash");
    const { messages, sendMessage, setMessages, stop, status, error, clearError } =
        useChat<RunUIMessage>({
            id: roomId,
            messages: initialMessages,
            transport,
        });

    const [view, setView] = useState<ThreadView>({
        threadId: initialThreadId,
        lastSeq: initialSeq,
        status: initialStatus,
        runBy: initialRunBy,
        retired: false,
    });
    const [isConnected, setIsConnected] = useState(false);
    const [refusal, setRefusal] = useState<string | null>(null);
    const viewRef = useRef(view);
    const ownRunRef = useRef(false);
    const readingRef = useRef(false);
    const staleRef = useRef(false);
    const setMessagesRef = useRef(setMessages);
    useEffect(() => {
        setMessagesRef.current = setMessages;
    });

    const updateView = useCallback((next: ThreadView) => {
        viewRef.current = next;
        setView(next);
    }, []);

    const adoptThread = useCallback(
        (threadId: string, retired: boolean) => {
            updateView({
                threadId,
                lastSeq: 0,
                status: "finished",
                runBy: null,
                retired,
            });
            setMessagesRef.current([]);
        },
        [updateView],
    );

    const applyMessages = useCallback((incoming: Array<RunUIMessage>) => {
        if (incoming.length === 0) return;
        setMessagesRef.current((current) => {
            const next = [...current];
            for (const message of incoming) {
                const index = next.findIndex((item) => item.id === message.id);
                if (index === -1) next.push(message);
                else next[index] = message;
            }
            return next;
        });
    }, []);

    const readThread = useCallback(async () => {
        const response = await fetch(
            `/api/runs?roomId=${roomId}&from=${viewRef.current.lastSeq}`,
        );
        if (!response.ok) return;
        const snapshot = (await response.json()) as ThreadSnapshot;

        if (snapshot.threadId !== viewRef.current.threadId) {
            adoptThread(snapshot.threadId, true);
            staleRef.current = true;
            return;
        }

        applyMessages(snapshot.messages.map((entry) => entry.message));
        updateView({
            ...viewRef.current,
            status: snapshot.status,
            runBy: snapshot.runBy,
            lastSeq: Math.max(
                viewRef.current.lastSeq,
                snapshot.messages.at(-1)?.seq ?? 0,
            ),
        });
    }, [adoptThread, applyMessages, roomId, updateView]);

    const sync = useCallback(async () => {
        if (ownRunRef.current || readingRef.current) {
            staleRef.current = true;
            return;
        }
        readingRef.current = true;
        try {
            do {
                staleRef.current = false;
                await readThread();
            } while (staleRef.current);
        } catch {
            // Offline or mid-navigation; the next announcement or resubscribe reads again.
        } finally {
            readingRef.current = false;
        }
    }, [readThread]);

    const applyEvent = useCallback(
        (event: RunThreadEvent) => {
            const current = viewRef.current;

            if (event.kind === "retired") {
                if (event.retiredThreadId !== current.threadId) return;
                adoptThread(event.threadId, true);
                return;
            }

            if (event.threadId !== current.threadId) return;

            updateView({ ...current, status: event.status, runBy: event.runBy });
            if (event.kind === "progress" && event.seq >= current.lastSeq) {
                void sync();
            }
        },
        [adoptThread, sync, updateView],
    );

    const streamingHere = status === "submitted" || status === "streaming";
    useEffect(() => {
        ownRunRef.current = streamingHere;
        if (!streamingHere) void sync();
    }, [streamingHere, sync]);

    useEffect(() => {
        if (isConnected) return;
        void sync();
        const interval = setInterval(() => void sync(), DISCONNECTED_POLL_MS);
        return () => clearInterval(interval);
    }, [isConnected, sync]);

    useEffect(() => {
        const channel = supabase
            .channel(runThreadTopic(roomId), { config: { private: true } })
            .on("broadcast", { event: RUN_THREAD_EVENT }, ({ payload }) => {
                const event = parseRunThreadEvent(payload);
                if (event !== null) applyEvent(event);
            })
            .subscribe((subscribeStatus) => {
                setIsConnected(subscribeStatus === "SUBSCRIBED");
                if (subscribeStatus === "SUBSCRIBED") void sync();
            });

        return () => {
            setIsConnected(false);
            void supabase.removeChannel(channel);
        };
    }, [applyEvent, roomId, supabase, sync]);

    function startRun(goal: string) {
        setRefusal(null);
        updateView({ ...viewRef.current, retired: false });
        const userMessageId = crypto.randomUUID();
        return sendMessage(
            {
                id: userMessageId,
                role: "user",
                parts: [{ type: "text", text: goal }],
                metadata: { author: currentUser },
            },
            { body: { roomId, goal, model, userMessageId } },
        );
    }

    const newThread = useCallback(async () => {
        setRefusal(null);
        let body: unknown;
        try {
            const response = await fetch(`/api/runs?roomId=${roomId}`, {
                method: "DELETE",
            });
            body = await response.json();
            if (!response.ok) {
                setRefusal(refusalNotice(body, "Could not start a new thread."));
                return;
            }
        } catch {
            setRefusal("Could not start a new thread.");
            return;
        }
        const { threadId } = body as { threadId?: unknown };
        if (typeof threadId !== "string") {
            setRefusal("Could not start a new thread.");
            return;
        }
        adoptThread(threadId, false);
    }, [adoptThread, roomId]);

    const notice =
        refusal ??
        (error === undefined ? null : refusalNotice(safeJson(error.message), error.message));

    const dismissNotice = useCallback(() => {
        setRefusal(null);
        clearError();
    }, [clearError]);

    return {
        messages,
        startRun,
        newThread,
        stop,
        status,
        threadStatus: view.status,
        runBy: view.runBy,
        threadRetired: view.retired,
        isConnected,
        notice,
        dismissNotice,
        model,
        setModel,
    };
}
