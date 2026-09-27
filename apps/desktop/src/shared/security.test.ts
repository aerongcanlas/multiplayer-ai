import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { commandSchema } from "./contracts";
import { isLocalDevUrl, isTrustedDocument } from "./security";
import {
  loginAllowed,
  parseTranscript,
  requestTimeout,
} from "../main/supervisor-messages";

test("IPC rejects arbitrary process and filesystem operations, extra fields and invalid payloads", () => {
  const roomId = randomUUID();
  for (const input of [
    { type: "exec", command: "whoami" },
    { type: "workspace.register", path: "C:\\private" },
    { type: "workspace.select", roomId, path: "C:\\private" },
    { type: "message.send", roomId, text: "hello", authorId: "another-user" },
    { type: "message.send", roomId, text: " " },
    { type: "message.send", roomId, text: "x".repeat(8_001) },
    { type: "snapshot", channel: "electron:raw" },
  ])
    assert.equal(commandSchema.safeParse(input).success, false);
});

test("selected-message IDs must be valid and unique", () => {
  const id = randomUUID();
  assert.equal(
    commandSchema.safeParse({
      type: "suggestion.create",
      roomId: id,
      messageIds: [id, id],
    }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({
      type: "suggestion.create",
      roomId: id,
      messageIds: [],
    }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({
      type: "suggestion.create",
      roomId: id,
      messageIds: [randomUUID()],
    }).success,
    true,
  );
});

test("sender validation rejects lookalike origins, different documents and query injection", () => {
  const expected = "multiplayer://desktop/index.html";
  assert.equal(isTrustedDocument(expected + "#activity", expected), true);
  for (const candidate of [
    "https://desktop/index.html",
    "multiplayer://desktop.evil/index.html",
    "multiplayer://desktop/secret.html",
    "multiplayer://desktop/index.html?inject=1",
    "file:///index.html",
    "invalid",
  ]) {
    assert.equal(isTrustedDocument(candidate, expected), false);
  }
  assert.equal(isLocalDevUrl("http://127.0.0.1:5173"), true);
  assert.equal(isLocalDevUrl("http://127.0.0.1.evil:5173"), false);
  assert.equal(isLocalDevUrl("https://example.com"), false);
});

test("transcript messages of unknown shape are dropped and sign-in URLs are allowlisted per harness", () => {
  const roomId = randomUUID();
  const tabId = randomUUID();
  const entry = {
    id: randomUUID(),
    tabId,
    seq: 1,
    turnId: null,
    kind: "assistant",
    share: "full",
    summary: "Hi",
    createdAt: "now",
    updatedAt: "now",
  };
  assert.deepEqual(parseTranscript([{ roomId, tabId, entries: [entry] }]), [
    { roomId, tabId, entries: [entry] },
  ]);
  for (const value of [
    [{ roomId, tabId, entries: [{ ...entry, kind: "shell" }] }],
    [{ roomId, tabId, entries: [], html: "<script>" }],
    { roomId, tabId },
    "batches",
  ])
    assert.equal(parseTranscript(value), null);
  assert.equal(
    loginAllowed("codex", "https://auth.openai.com/authorize"),
    true,
  );
  assert.equal(loginAllowed("codex", "https://auth.openai.com.evil/x"), false);
  assert.equal(loginAllowed("codex", "http://auth.openai.com/x"), false);
  assert.equal(loginAllowed("codex", "https://user:pw@chatgpt.com/x"), false);
  // Claude Code tabs never open an in-app sign-in.
  assert.equal(loginAllowed("claude", "https://claude.ai/login"), false);
  assert.equal(loginAllowed("cursor", "https://auth.openai.com/x"), false);
  assert.equal(requestTimeout("harness.refresh"), 90_000);
  assert.equal(requestTimeout("tab.send"), 20_000);
});

test("the renderer cannot set an executable path", () => {
  for (const input of [
    { type: "harness.setExecutable", harness: "codex", path: "/bin/sh" },
    { type: "harness.chooseExecutable", harness: "codex", path: "/bin/sh" },
    { type: "host.environment", env: { PATH: "/tmp" } },
  ])
    assert.equal(commandSchema.safeParse(input).success, false);
});
