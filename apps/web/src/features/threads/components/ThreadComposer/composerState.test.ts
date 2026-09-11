import assert from "node:assert/strict";
import test from "node:test";
import {
    applyAsyncDraft,
    createComposerDraft,
    resolveSubmission,
    shouldSubmitComposerKey,
    submissionFromDraft,
    updateComposerDraft,
    validatePrompt,
} from "./composerState";

test("busy or rejected submission retains the prompt", () => {
    const draft = createComposerDraft("room:thread", "keep this", 4);
    const submission = submissionFromDraft(draft);
    assert.deepEqual(submission, {
        targetKey: "room:thread",
        text: "keep this",
        revision: 4,
    });
    assert.deepEqual(submissionFromDraft(draft, { busy: true }), null);
    assert.deepEqual(
        resolveSubmission(draft, submission!, { accepted: false }),
        draft,
    );
});

test("accepted result clears only the submitted revision", () => {
    const draft = createComposerDraft("room:thread", "first", 2);
    const submission = submissionFromDraft(draft)!;
    const edited = updateComposerDraft(draft, "newer", "room:thread");
    assert.equal(
        resolveSubmission(edited, submission, undefined).value,
        "newer",
    );
    assert.equal(resolveSubmission(draft, submission, undefined).value, "");
});

test("late suggestion or failure cannot cross target or overwrite an edit", () => {
    const current = updateComposerDraft(
        createComposerDraft("room:b", "manual edit", 8),
        "manual edit",
        "room:b",
    );
    assert.deepEqual(
        applyAsyncDraft(current, {
            targetKey: "room:a",
            revision: 8,
            value: "late suggestion",
        }),
        current,
    );
    assert.deepEqual(
        applyAsyncDraft(current, {
            targetKey: "room:b",
            revision: 7,
            value: "late failure recovery",
        }),
        current,
    );
});

test("empty and overlong prompts are rejected, with Unicode counted as characters", () => {
    assert.match(validatePrompt("  ")!, /direction/i);
    assert.match(validatePrompt("a".repeat(4_001))!, /4,000/);
    assert.equal(validatePrompt("🙂".repeat(4_000)), null);
    assert.match(validatePrompt("🙂".repeat(4_001))!, /4,000/);
});

test("Enter submits while Shift+Enter and IME composition remain multiline-safe", () => {
    assert.equal(
        shouldSubmitComposerKey({
            key: "Enter",
            shiftKey: false,
            nativeComposing: false,
            composing: false,
        }),
        true,
    );
    assert.equal(
        shouldSubmitComposerKey({
            key: "Enter",
            shiftKey: true,
            nativeComposing: false,
            composing: false,
        }),
        false,
    );
    assert.equal(
        shouldSubmitComposerKey({
            key: "Enter",
            shiftKey: false,
            nativeComposing: true,
            composing: true,
        }),
        false,
    );
});
