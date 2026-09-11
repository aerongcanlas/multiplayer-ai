import type { ModelKey } from "@multiplayer-ai/domain";

export const MAX_PROMPT_LENGTH = 4_000;

export type ComposerDraft = {
    targetKey: string;
    value: string;
    revision: number;
};

export type ComposerSubmission = {
    targetKey: string;
    text: string;
    revision: number;
};

export type AsyncDraft = {
    targetKey: string;
    revision: number;
    value: string;
};

export type SubmissionResult = { accepted?: boolean } | void;

export function createComposerDraft(
    targetKey: string,
    value = "",
    revision = 0,
): ComposerDraft {
    return { targetKey, value, revision };
}

export function updateComposerDraft(
    draft: ComposerDraft,
    value: string,
    targetKey = draft.targetKey,
): ComposerDraft {
    return {
        targetKey,
        value,
        revision: draft.revision + 1,
    };
}

/** Returns null for an acceptable prompt, otherwise a user-facing error. */
export function validatePrompt(value: string): string | null {
    if (value.trim().length === 0) return "Enter a direction first.";
    if (Array.from(value).length > MAX_PROMPT_LENGTH) {
        return "Prompt must be 4,000 characters or fewer.";
    }
    return null;
}

export function submissionFromDraft(
    draft: ComposerDraft,
    options: { busy?: boolean; disabled?: boolean; composing?: boolean } = {},
): ComposerSubmission | null {
    if (options.busy || options.disabled || options.composing) return null;
    if (validatePrompt(draft.value) !== null) return null;
    return {
        targetKey: draft.targetKey,
        text: draft.value.trim(),
        revision: draft.revision,
    };
}

export function shouldSubmitComposerKey(input: {
    key: string;
    shiftKey: boolean;
    nativeComposing: boolean;
    composing: boolean;
}) {
    return (
        input.key === "Enter" &&
        !input.shiftKey &&
        !input.nativeComposing &&
        !input.composing
    );
}

/**
 * Clear only the revision that was accepted. A retry, a newer edit, or a
 * response for another selected thread must leave the current draft alone.
 */
export function resolveSubmission(
    current: ComposerDraft,
    submission: ComposerSubmission,
    result: SubmissionResult,
): ComposerDraft {
    if (result && result.accepted === false) return current;
    if (
        current.targetKey !== submission.targetKey ||
        current.revision !== submission.revision ||
        current.value.trim() !== submission.text
    ) {
        return current;
    }
    return updateComposerDraft(current, "", current.targetKey);
}

/** Apply a late suggestion only if the captured target and edit are current. */
export function applyAsyncDraft(
    current: ComposerDraft,
    incoming: AsyncDraft,
): ComposerDraft {
    if (
        current.targetKey !== incoming.targetKey ||
        current.revision !== incoming.revision
    ) {
        return current;
    }
    return updateComposerDraft(current, incoming.value, current.targetKey);
}

export function modelLabel(model: ModelKey): string {
    return model.replace(/^\w+:/, "");
}
