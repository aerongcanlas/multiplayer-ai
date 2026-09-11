"use client";

import type { ContextSuggestion } from "@multiplayer-ai/domain";
import { useThreadSessionContext } from "@/features/threads/session/ThreadSessionProvider";
import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type ReactNode,
} from "react";

type PromptSuggestionContextValue = {
    suggestion: ContextSuggestion | null;
    isGenerating: boolean;
    error: string | null;
    draftPrompt: string;
    beginGeneration: (roomId: string) => string | null;
    completeGeneration: (
        requestId: string,
        suggestion: ContextSuggestion,
    ) => void;
    failGeneration: (requestId: string, error: string) => void;
    applyPrompt: (prompt: string) => boolean;
};

type SuggestionTarget = {
    requestId: string;
    roomId: string;
    threadId: string;
    revision: number;
};

const PromptSuggestionContext =
    createContext<PromptSuggestionContextValue | null>(null);

export function PromptSuggestionProvider({
    children,
}: {
    children: ReactNode;
}) {
    const { registry } = useThreadSessionContext();
    useSyncExternalStore(
        registry.subscribe,
        registry.snapshot,
        registry.snapshot,
    );
    const [suggestion, setSuggestion] = useState<ContextSuggestion | null>(
        null,
    );
    const [isGenerating, setIsGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const targetRef = useRef<SuggestionTarget | null>(null);
    const [target, setTarget] = useState<SuggestionTarget | null>(null);

    const beginGeneration = useCallback(
        (roomId: string) => {
            const threadId = registry.selected(roomId);
            if (threadId === undefined) return null;
            const requestId = crypto.randomUUID();
            targetRef.current = {
                requestId,
                roomId,
                threadId,
                revision: registry.ensure(roomId, threadId).state.draftRevision,
            };
            setTarget(targetRef.current);
            setSuggestion(null);
            setError(null);
            setIsGenerating(true);
            return requestId;
        },
        [registry],
    );

    const completeGeneration = useCallback(
        (requestId: string, nextSuggestion: ContextSuggestion) => {
            if (targetRef.current?.requestId !== requestId) return;
            setSuggestion(nextSuggestion);
            setError(null);
            setIsGenerating(false);
        },
        [],
    );

    const failGeneration = useCallback(
        (requestId: string, nextError: string) => {
            if (targetRef.current?.requestId !== requestId) return;
            setSuggestion(null);
            setError(nextError);
            setIsGenerating(false);
        },
        [],
    );

    const applyPrompt = useCallback(
        (prompt: string) => {
            const target = targetRef.current;
            if (target === null) return false;
            const applied = registry.setDraftIfRevision(
                target.roomId,
                target.threadId,
                target.revision,
                prompt,
            );
            if (!applied) {
                setError(
                    "The target draft changed. Generate suggestions again to avoid overwriting it.",
                );
            }
            return applied;
        },
        [registry],
    );

    const draftPrompt =
        target === null
            ? ""
            : (registry.get(target.roomId, target.threadId)?.state.draft ?? "");

    const value = useMemo(
        () => ({
            suggestion,
            isGenerating,
            error,
            draftPrompt,
            beginGeneration,
            completeGeneration,
            failGeneration,
            applyPrompt,
        }),
        [
            suggestion,
            isGenerating,
            error,
            draftPrompt,
            beginGeneration,
            completeGeneration,
            failGeneration,
            applyPrompt,
        ],
    );

    return (
        <PromptSuggestionContext value={value}>
            {children}
        </PromptSuggestionContext>
    );
}

export function usePromptSuggestions(): PromptSuggestionContextValue {
    const value = useContext(PromptSuggestionContext);
    if (value === null) {
        throw new Error(
            "usePromptSuggestions must be used within PromptSuggestionProvider",
        );
    }
    return value;
}
