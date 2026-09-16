import test from "node:test";
import assert from "node:assert/strict";
import { OAuthCallback } from "./oauth-callback";

test("OAuth callback rejects invalid state and accepts one matching code", async () => {
  const callback = new OAuthCallback();
  const flow = await callback.start(0);
  try {
    const wrong = new URL(flow.redirectTo);
    wrong.searchParams.set("state", "wrong");
    assert.equal((await fetch(wrong)).status, 400);
    await assert.rejects(callback.start(0), /already open/);
    const correct = new URL(flow.redirectTo);
    correct.searchParams.set("code", "only-once");
    assert.equal((await fetch(correct)).status, 200);
    assert.equal(await flow.code, "only-once");
    await assert.rejects(fetch(correct));
  } finally {
    callback.cancel();
  }
});

test("OAuth callback times out and releases its listening socket", async () => {
  const callback = new OAuthCallback();
  const flow = await callback.start(0, 30);
  await assert.rejects(flow.code, /expired/);
  const second = await callback.start(0);
  callback.cancel();
  await assert.rejects(second.code, /cancelled/);
});
