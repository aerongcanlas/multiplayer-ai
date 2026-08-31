"use client";

import type { ContextSuggestion } from "@multiplayer-ai/domain";
import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useState,
    type ReactNode,
} from "react";

type PromptSuggestionContextValue = {
    suggestion: ContextSuggestion | null;
    isGenerating: boolean;
    error: string | null;
    draftPrompt: string;
    beginGeneration: () => void;
    completeGeneration: (suggestion: ContextSuggestion) => void;
    failGeneration: (error: string) => void;
    setDraftPrompt: (prompt: string) => void;
};

const PromptSuggestionContext =
    createContext<PromptSuggestionContextValue | null>(null);

export function PromptSuggestionProvider({ children }: { children: ReactNode }) {
    const [suggestion, setSuggestion] = useState<ContextSuggestion | null>(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [draftPrompt, setDraftPrompt] = useState("");

    const beginGeneration = useCallback(() => {
        setSuggestion(null);
        setError(null);
        setIsGenerating(true);
    }, []);

    const completeGeneration = useCallback(
        (nextSuggestion: ContextSuggestion) => {
            setSuggestion(nextSuggestion);
            setError(null);
            setIsGenerating(false);
        },
        [],
    );

    const failGeneration = useCallback((nextError: string) => {
        setSuggestion(null);
        setError(nextError);
        setIsGenerating(false);
    }, []);

    const value = useMemo(
        () => ({
            suggestion,
            isGenerating,
            error,
            draftPrompt,
            beginGeneration,
            completeGeneration,
            failGeneration,
            setDraftPrompt,
        }),
        [
            suggestion,
            isGenerating,
            error,
            draftPrompt,
            beginGeneration,
            completeGeneration,
            failGeneration,
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
