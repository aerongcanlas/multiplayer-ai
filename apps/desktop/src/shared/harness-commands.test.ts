import test from "node:test";
import assert from "node:assert/strict";
import { commandSchema } from "./contracts";

test("sign-out and cancel commands accept only known harnesses", () => {
  for (const type of ["harness.signOut", "harness.cancelSignIn"]) {
    assert.ok(commandSchema.safeParse({ type, harness: "claude" }).success);
    assert.equal(
      commandSchema.safeParse({ type, harness: "cursor" }).success,
      false,
    );
    assert.equal(
      commandSchema.safeParse({ type, harness: "codex", extra: 1 }).success,
      false,
    );
  }
});
