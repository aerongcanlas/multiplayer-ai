import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { commandSchema } from "./contracts";
import {
  SHARE_LEVELS,
  TRANSCRIPT_KINDS,
  tabSchema,
  transcriptEntrySchema,
} from "./tabs";

const entry = (kind: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  tabId: randomUUID(),
  seq: 1,
  turnId: randomUUID(),
  kind,
  share: SHARE_LEVELS[kind as keyof typeof SHARE_LEVELS] ?? "none",
  summary: "text",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...extra,
});

test("every transcript kind parses and unknown kinds or fields are rejected", () => {
  for (const kind of TRANSCRIPT_KINDS)
    assert.equal(transcriptEntrySchema.safeParse(entry(kind)).success, true);
  assert.equal(transcriptEntrySchema.safeParse(entry("diff")).success, false);
  assert.equal(
    transcriptEntrySchema.safeParse(entry("assistant", { raw: "x" })).success,
    false,
  );
  const question = entry("question", {
    state: "pending",
    questions: [
      {
        id: "q1",
        header: "Scope",
        question: "Which scope?",
        options: [{ label: "Small", description: "Just this file" }],
        multiSelect: false,
        allowOther: true,
        secret: false,
      },
    ],
  });
  assert.equal(transcriptEntrySchema.safeParse(question).success, true);
});

test("tool output is summary-shared and reasoning is never shared", () => {
  assert.equal(SHARE_LEVELS.tool, "summary");
  assert.equal(SHARE_LEVELS.approval, "summary");
  assert.equal(SHARE_LEVELS.reasoning, "none");
  assert.equal(SHARE_LEVELS.question, "none");
  assert.equal(SHARE_LEVELS.assistant, "full");
  assert.equal(SHARE_LEVELS.user, "full");
});

test("sub-agent cards and entries parse, and an unknown card status is rejected", () => {
  const card = {
    key: "task-1",
    type: "Explore",
    status: "running",
    background: true,
    startedAt: new Date().toISOString(),
    toolUses: 0,
  };
  assert.equal(
    transcriptEntrySchema.safeParse(entry("agent", { agent: card })).success,
    true,
  );
  assert.equal(
    transcriptEntrySchema.safeParse(
      entry("agent", { agent: { ...card, status: "paused" } }),
    ).success,
    false,
  );
  assert.equal(
    transcriptEntrySchema.safeParse(entry("approval", { agentKey: "task-1" }))
      .success,
    true,
  );
});

test("cards share in full and sub-agent entries keep their kind's level", () => {
  assert.equal(SHARE_LEVELS.agent, "full");
  const reasoning = entry("reasoning", { agentKey: "task-1" });
  assert.equal(reasoning.share, "none");
});

test("tabs start without read-along", () => {
  const base = {
    id: randomUUID(),
    roomId: randomUUID(),
    title: "Codex 1",
    loadout: { harness: "codex", model: "", planMode: false, access: "ask" },
    status: "idle",
    readAlong: false,
    createdAt: "now",
    updatedAt: "now",
  };
  assert.equal(tabSchema.safeParse(base).success, true);
  assert.equal(
    tabSchema.safeParse({
      ...base,
      runningAgents: 1,
      agentRequests: 0,
      plan: {
        turnId: null,
        steps: [{ text: "Inspect", status: "active" }],
        updatedAt: "now",
      },
    }).success,
    true,
  );
  assert.equal(
    tabSchema.safeParse({ ...base, runningAgents: -1 }).success,
    false,
  );
  assert.equal(
    tabSchema.safeParse({ ...base, readAlong: true }).success,
    false,
  );
  assert.equal(
    tabSchema.safeParse({
      ...base,
      loadout: { ...base.loadout, harness: "cursor" },
    }).success,
    false,
  );
});

test("tab commands validate size, identity, and scope", () => {
  const send = {
    type: "tab.send",
    roomId: randomUUID(),
    tabId: randomUUID(),
    text: "Hello",
  };
  assert.equal(commandSchema.safeParse(send).success, true);
  assert.equal(
    commandSchema.safeParse({ ...send, text: "x".repeat(8_001) }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({ ...send, tabId: "not-a-uuid" }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({ ...send, roomId: undefined }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({ ...send, extra: true }).success,
    false,
  );
  // Executable paths are chosen in main's native dialog, never sent by the renderer.
  assert.equal(
    commandSchema.safeParse({
      type: "harness.setExecutable",
      harness: "codex",
      path: "/bin/sh",
    }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({
      type: "harness.chooseExecutable",
      harness: "codex",
      path: "/bin/sh",
    }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({
      type: "approval.respond",
      roomId: randomUUID(),
      tabId: randomUUID(),
      executionId: randomUUID(),
      approvalId: randomUUID(),
      decision: "accept",
    }).success,
    false,
  );
});
