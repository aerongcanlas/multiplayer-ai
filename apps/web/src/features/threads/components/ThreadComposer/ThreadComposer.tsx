"use client";

import { ArrowUp, RotateCcw } from "lucide-react";
import type { ModelKey } from "@multiplayer-ai/domain";
import { BoxColumn, BoxRow, Button, TextBox } from "@/components/ui";
import RunModelSwitcher from "@/features/runs/components/RunModelSwitcher";
import { cn } from "@/lib/utils";
import {
    createComposerDraft,
    resolveSubmission,
    shouldSubmitComposerKey,
    submissionFromDraft,
    updateComposerDraft,
    validatePrompt,
    type SubmissionResult,
} from "./composerState";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export interface ThreadComposerProps {
    value: string;
    revision: number;
    targetKey: string;
    model: ModelKey;
    onValueChange(value: string): void;
    onModelChange(model: ModelKey): void;
    onSubmit(
        text: string,
        revision: number,
    ): Promise<SubmissionResult> | SubmissionResult;
    onAccepted?(revision: number, result: SubmissionResult): void;
    disabled?: boolean;
    busy?: boolean;
    placeholder?: string;
    context?: ReactNode;
    controls?: ReactNode;
    error?: ReactNode;
    onRetry?(): void;
    className?: string;
}

function ThreadComposer({
    value,
    revision,
    targetKey,
    model,
    onValueChange,
    onModelChange,
    onSubmit,
    onAccepted,
    disabled = false,
    busy = false,
    placeholder = "What should the agent do?",
    context,
    controls,
    error,
    onRetry,
    className,
}: ThreadComposerProps) {
    const [composing, setComposing] = useState(false);
    const [submittingTargets, setSubmittingTargets] = useState<Set<string>>(
        () => new Set(),
    );
    const validationId = useId();
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const draftRef = useRef(createComposerDraft(targetKey, value, revision));

    useEffect(() => {
        draftRef.current = createComposerDraft(targetKey, value, revision);
    }, [revision, targetKey, value]);

    const resizeTextarea = () => {
        const textarea = textareaRef.current;
        if (textarea === null) return;
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(textarea.scrollHeight, 192)}px`;
    };

    useEffect(resizeTextarea, [value]);

    async function submit() {
        const draft = draftRef.current;
        const submitting = submittingTargets.has(targetKey);
        const submission = submissionFromDraft(draft, {
            busy: busy || submitting,
            disabled,
            composing,
        });
        if (submission === null) return;

        setSubmittingTargets((current) => new Set(current).add(targetKey));
        try {
            const result = await onSubmit(submission.text, submission.revision);
            if (result?.accepted !== false) {
                if (onAccepted !== undefined) {
                    onAccepted(submission.revision, result);
                } else {
                    const next = resolveSubmission(
                        draftRef.current,
                        submission,
                        result,
                    );
                    if (next !== draftRef.current) {
                        draftRef.current = next;
                        onValueChange("");
                    }
                }
            }
        } finally {
            setSubmittingTargets((current) => {
                const next = new Set(current);
                next.delete(submission.targetKey);
                return next;
            });
        }
    }

    function handleValueChange(nextValue: string) {
        const next = updateComposerDraft(
            draftRef.current,
            nextValue,
            targetKey,
        );
        draftRef.current = next;
        onValueChange(nextValue);
    }

    function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
        if (!shouldSubmitComposerKey({
            key: event.key,
            shiftKey: event.shiftKey,
            nativeComposing: event.nativeEvent.isComposing,
            composing,
        })) {
            return;
        }
        event.preventDefault();
        void submit();
    }

    const validationError = value.length > 0 ? validatePrompt(value) : null;
    const submitting = submittingTargets.has(targetKey);
    const sendDisabled =
        disabled ||
        busy ||
        submitting ||
        composing ||
        validationError !== null ||
        value.trim().length === 0;

    return (
        <BoxColumn
            className={cn(
                "gap-2 rounded-3xl border border-white/10 bg-[#242424] p-3 shadow-sm",
                className,
            )}
        >
            {context}
            {error !== undefined && error !== null && (
                <BoxRow
                    className="items-center justify-between gap-2 rounded-xl bg-red-500/10 px-3 py-2"
                    role="alert"
                >
                    <TextBox className="text-xs text-red-300/90">
                        {error}
                    </TextBox>
                    {onRetry !== undefined && (
                        <Button
                            aria-label="Retry loading this thread"
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={onRetry}
                        >
                            <RotateCcw />
                            Retry
                        </Button>
                    )}
                </BoxRow>
            )}
            <textarea
                ref={textareaRef}
                aria-label="Message the agent"
                aria-describedby={
                    validationError === null ? undefined : validationId
                }
                aria-invalid={validationError !== null}
                className="max-h-48 min-h-20 w-full resize-none overflow-y-auto bg-transparent px-1 py-1 text-sm leading-6 outline-none placeholder:text-white/40 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={disabled}
                placeholder={placeholder}
                rows={3}
                value={value}
                onChange={(event) => handleValueChange(event.target.value)}
                onCompositionEnd={() => setComposing(false)}
                onCompositionStart={() => setComposing(true)}
                onKeyDown={handleKeyDown}
            />
            {validationError !== null && value.length > 0 && (
                <TextBox
                    id={validationId}
                    className="px-1 text-xs text-destructive"
                    role="alert"
                >
                    {validationError}
                </TextBox>
            )}
            <BoxRow className="items-center justify-between gap-2 border-t border-white/10 pt-2">
                <BoxRow className="min-w-0 items-center gap-2">
                    <RunModelSwitcher value={model} onChange={onModelChange} />
                    {controls}
                </BoxRow>
                <Button
                    aria-label={busy ? "Agent is busy" : "Send message"}
                    disabled={sendDisabled}
                    size="icon"
                    type="button"
                    onClick={() => void submit()}
                >
                    <ArrowUp />
                </Button>
            </BoxRow>
        </BoxColumn>
    );
}

export default ThreadComposer;
