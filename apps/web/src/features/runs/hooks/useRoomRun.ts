"use client";

import { useChat } from "@ai-sdk/react";
import type { ModelKey } from "@multiplayer-ai/domain";
import { DefaultChatTransport } from "ai";
import { useCallback, useState } from "react";
import type { RunUIMessage } from "@/features/runs/types/runMessage";

const transport = new DefaultChatTransport<RunUIMessage>({ api: "/api/runs" });

interface Options {
    roomId: string;
    initialMessages?: Array<RunUIMessage>;
}

export function useRoomRun({ roomId, initialMessages }: Options) {
    const [model, setModel] = useState<ModelKey>("google:gemini-3.6-flash");
    const { messages, sendMessage, setMessages, stop, status, error, clearError } =
        useChat<RunUIMessage>({
            id: roomId,
            messages: initialMessages,
            transport,
        });

    function startRun(goal: string) {
        return sendMessage({ text: goal }, { body: { roomId, goal, model } });
    }

    const newThread = useCallback(async () => {
        await fetch(`/api/runs?roomId=${roomId}`, { method: "DELETE" });
        setMessages([]);
    }, [roomId, setMessages]);

    return {
        messages,
        startRun,
        newThread,
        stop,
        status,
        error,
        clearError,
        model,
        setModel,
    };
}
