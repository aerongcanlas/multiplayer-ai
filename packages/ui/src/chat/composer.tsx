"use client";

import { ArrowUp, RotateCcw } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "../primitives/button";
import { cn } from "../lib/utils";
import {
  createComposerDraft,
  resolveSubmission,
  shouldSubmitComposerKey,
  submissionFromDraft,
  updateComposerDraft,
  validatePrompt,
  type SubmissionResult,
} from "./composer-state";

export interface ComposerProps {
  value: string;
  revision?: number;
  targetKey: string;
  onValueChange(value: string): void;
  onSubmit(
    text: string,
    revision: number,
  ): Promise<SubmissionResult> | SubmissionResult;
  onAccepted?(revision: number, result: SubmissionResult): void;
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
  label?: string;
  submitLabel?: string;
  maxLength?: number;
  lengthUnit?: "code-points" | "code-units";
  context?: ReactNode;
  controls?: ReactNode;
  error?: ReactNode;
  onRetry?(): void;
  className?: string;
  appearance?: "default" | "compact";
}

/** Transport-independent input. Only an acknowledged, unchanged draft is cleared. */
export function Composer({
  value,
  revision,
  targetKey,
  onValueChange,
  onSubmit,
  onAccepted,
  disabled = false,
  busy = false,
  placeholder = "What should the agent do?",
  label = "Message the agent",
  submitLabel = "Send message",
  maxLength = 4000,
  lengthUnit = "code-points",
  context,
  controls,
  error,
  onRetry,
  className,
  appearance = "default",
}: ComposerProps) {
  const [composing, setComposing] = useState(false);
  const [pendingTargets, setPendingTargets] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [submissionError, setSubmissionError] = useState<{
    target: string;
    text: string;
  } | null>(null);
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(createComposerDraft(targetKey, value, revision));
  const validationId = useId();
  const errorId = useId();
  const compact = appearance === "compact";

  useLayoutEffect(() => {
    const current = draftRef.current;
    draftRef.current = createComposerDraft(
      targetKey,
      value,
      revision ??
        (current.value === value && current.targetKey === targetKey
          ? current.revision
          : current.revision + 1),
    );
  }, [revision, targetKey, value]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (compact) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 192)}px`;
  }, [value, compact]);

  async function submit() {
    const submission = submissionFromDraft(draftRef.current, {
      busy: busy || inFlight.current.has(targetKey),
      disabled,
      composing,
      maxLength,
      lengthUnit,
    });
    if (!submission) return;
    inFlight.current.add(submission.targetKey);
    setPendingTargets(new Set(inFlight.current));
    setSubmissionError(null);
    try {
      const result = await onSubmit(submission.text, submission.revision);
      if (!mounted.current || result?.accepted === false) return;
      if (onAccepted) onAccepted(submission.revision, result);
      else {
        const next = resolveSubmission(draftRef.current, submission, result);
        if (next !== draftRef.current) {
          draftRef.current = next;
          onValueChange("");
        }
      }
    } catch {
      if (mounted.current)
        setSubmissionError({
          target: submission.targetKey,
          text: "Could not send. Your draft is saved here; try again.",
        });
    } finally {
      inFlight.current.delete(submission.targetKey);
      if (mounted.current) setPendingTargets(new Set(inFlight.current));
    }
  }

  const validationError = value.length
    ? validatePrompt(value, maxLength, lengthUnit)
    : null;
  const visibleError =
    error ??
    (submissionError?.target === targetKey ? submissionError.text : null);
  const sendDisabled =
    disabled ||
    busy ||
    pendingTargets.has(targetKey) ||
    composing ||
    validationError !== null ||
    !value.trim();
  return (
    <form
      data-slot="composer"
      className={cn(
        compact
          ? "composer"
          : "flex flex-col gap-2 rounded-3xl border border-white/10 bg-[#242424] p-3 shadow-sm",
        className,
      )}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {context}
      {visibleError != null && (
        <div
          id={errorId}
          className="flex items-center justify-between gap-2 rounded-xl bg-red-500/10 px-3 py-2"
          role="alert"
        >
          <span className="text-xs text-red-300/90">{visibleError}</span>
          {onRetry && (
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
        </div>
      )}
      <textarea
        ref={textareaRef}
        aria-label={label}
        aria-describedby={
          [
            validationError ? validationId : null,
            visibleError != null ? errorId : null,
          ]
            .filter(Boolean)
            .join(" ") || undefined
        }
        aria-invalid={validationError !== null}
        className={
          compact
            ? undefined
            : "max-h-48 min-h-20 w-full resize-none overflow-y-auto bg-transparent px-1 py-1 text-sm leading-6 outline-none placeholder:text-white/40 disabled:cursor-not-allowed disabled:opacity-50"
        }
        disabled={disabled}
        placeholder={placeholder}
        rows={compact ? 2 : 3}
        maxLength={lengthUnit === "code-units" ? maxLength : undefined}
        value={value}
        onChange={(event) => {
          draftRef.current = updateComposerDraft(
            draftRef.current,
            event.target.value,
            targetKey,
          );
          onValueChange(event.target.value);
        }}
        onCompositionEnd={() => setComposing(false)}
        onCompositionStart={() => setComposing(true)}
        onKeyDown={(event) => {
          if (
            !shouldSubmitComposerKey({
              key: event.key,
              shiftKey: event.shiftKey,
              nativeComposing: event.nativeEvent.isComposing,
              composing,
            })
          )
            return;
          event.preventDefault();
          void submit();
        }}
      />
      {validationError && (
        <span
          id={validationId}
          className="px-1 text-xs text-destructive"
          role="alert"
        >
          {validationError}
        </span>
      )}
      <div
        className={
          compact
            ? "composer-footer"
            : "flex items-center justify-between gap-2 border-t border-white/10 pt-2"
        }
      >
        <div
          className={compact ? undefined : "flex min-w-0 items-center gap-2"}
        >
          {controls ??
            (compact ? (
              <span>Enter to send · Shift+Enter for a new line</span>
            ) : null)}
        </div>
        <Button
          aria-label={busy ? "Agent is busy" : submitLabel}
          title={submitLabel}
          disabled={sendDisabled}
          size={compact ? "icon-sm" : "icon"}
          type="submit"
        >
          <ArrowUp size={compact ? 16 : undefined} />
        </Button>
      </div>
    </form>
  );
}
