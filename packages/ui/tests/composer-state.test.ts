import assert from "node:assert/strict";
import test from "node:test";
import {
  createComposerDraft,
  resolveSubmission,
  submissionFromDraft,
  updateComposerDraft,
  validatePrompt,
} from "../src/chat/composer-state";

test("each app can enforce its transport's character limit", () => {
  for (const maxLength of [1000, 2000, 4000, 8000]) {
    assert.equal(validatePrompt("a".repeat(maxLength), maxLength), null);
    assert.match(
      validatePrompt("a".repeat(maxLength + 1), maxLength)!,
      /characters or fewer/,
    );
    assert.equal(
      submissionFromDraft(
        createComposerDraft("room", "x".repeat(maxLength + 1)),
        { maxLength },
      ),
      null,
    );
  }
  assert.equal(validatePrompt("🙂".repeat(4000)), null);
  assert.match(validatePrompt("🙂".repeat(4001), 8000, "code-units")!, /8,000/);
  assert.equal(
    submissionFromDraft(createComposerDraft("room", "🙂".repeat(4001)), {
      maxLength: 8000,
      lengthUnit: "code-units",
    }),
    null,
  );
});

test("a late acknowledgment cannot clear another room or an edited-back draft", () => {
  const draft = createComposerDraft("room:a", "original", 1);
  const sent = submissionFromDraft(draft)!;
  const other = createComposerDraft("room:b", "original", 1);
  assert.equal(resolveSubmission(other, sent, { accepted: true }), other);
  const editedBack = updateComposerDraft(
    updateComposerDraft(draft, "edit"),
    "original",
  );
  assert.equal(
    resolveSubmission(editedBack, sent, { accepted: true }),
    editedBack,
  );
  assert.equal(resolveSubmission(draft, sent, { accepted: false }), draft);
  assert.equal(resolveSubmission(draft, sent, { accepted: true }).value, "");
});
