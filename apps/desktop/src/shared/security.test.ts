import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { commandSchema } from "./contracts";
import { isLocalDevUrl, isTrustedDocument } from "./security";

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
