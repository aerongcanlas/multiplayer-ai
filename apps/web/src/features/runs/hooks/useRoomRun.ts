"use client";

import { useChat } from "@ai-sdk/react";
import type { ModelKey } from "@multiplayer-ai/domain";
import { DefaultChatTransport } from "ai";
import { useState } from "react";
import type { RunUIMessage } from "@/features/runs/types/runMessage";

const transport = new DefaultChatTransport<RunUIMessage>({ api: "/api/runs" });

export function useRoomRun(roomId: string) {
    const [model, setModel] = useState<ModelKey>("google:gemini-3.6-flash");
    const { messages, sendMessage, stop, status, error, clearError } =
        useChat<RunUIMessage>({ transport });

    function startRun(goal: string) {
        return sendMessage({ text: goal }, { body: { roomId, goal, model } });
    }

    return { messages, startRun, stop, status, error, clearError, model, setModel };
}
