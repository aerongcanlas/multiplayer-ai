import test from "node:test";
import assert from "node:assert/strict";
import type { HarnessState } from "../../shared/tabs";
import {
  accountActions,
  authLabel,
  modelGroups,
  readiness,
  serverLine,
} from "./harness-status";

const opencode = (extra: Partial<HarnessState> = {}): HarnessState => ({
  id: "opencode",
  label: "OpenCode",
  program: { state: "ready", version: "1.18.34", pinned: "1.18.34" },
  auth: { state: "signed_in", account: "Local models" },
  signIn: "guidance",
  models: [],
  modelsRefreshedAt: null,
  limits: [],
  reportsAgents: false,
  noticePending: false,
  ...extra,
});
const model = (id: string) => ({
  id,
  name: id.split("/")[1]!,
  efforts: [],
  defaultEffort: null,
  isDefault: false,
});

test("OpenCode without a usable model reads as no models, not a sign-in (AE3)", () => {
  const state = opencode({
    auth: {
      state: "signed_out",
      message: "No models available. Start Ollama…",
    },
  });
  assert.deepEqual(readiness(state), {
    ready: false,
    text: "No models available",
  });
  assert.equal(authLabel(state), "No models available");
  // Codex and Claude Code still ask for a sign-in.
  assert.equal(
    readiness({ ...state, id: "codex", label: "Codex" }).text,
    "Sign in required",
  );
});

test("local servers read as one line each", () => {
  const models = [
    { id: "qwen3-coder:30b", name: "qwen3-coder:30b", context: 65_536 },
    { id: "gemma3:12b", name: "gemma3:12b" },
    { id: "devstral", name: "devstral" },
  ];
  assert.equal(
    serverLine({ id: "ollama", label: "Ollama", running: true, models }),
    "Ollama · 3 models",
  );
  assert.equal(
    serverLine({
      id: "lmstudio",
      label: "LM Studio",
      running: false,
      models: [],
    }),
    "LM Studio · not running",
  );
  assert.equal(
    serverLine({ id: "ollama", label: "Ollama", running: true, models: [] }),
    "Ollama · no tool-capable models",
  );
});

test("the model picker groups OpenCode models by provider and leaves others in one group", () => {
  const groups = modelGroups([
    model("ollama/qwen3-coder:30b"),
    model("lmstudio/qwen3-coder-30b"),
    model("ollama/gemma3:12b"),
    model("anthropic/claude-sonnet"),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.label, group.models.map((item) => item.id)]),
    [
      ["Ollama", ["ollama/qwen3-coder:30b", "ollama/gemma3:12b"]],
      ["LM Studio", ["lmstudio/qwen3-coder-30b"]],
      ["anthropic", ["anthropic/claude-sonnet"]],
    ],
  );
  // Context warnings live on the Settings server rows, never on picker models.
  assert.ok(
    groups.every((group) => group.models.every((item) => !("warning" in item))),
  );
  assert.deepEqual(
    modelGroups([{ ...model("x/gpt-5"), id: "gpt-5" }]).map(
      (group) => group.label,
    ),
    [null],
  );
});

const harness = (
  id: HarnessState["id"],
  signIn: HarnessState["signIn"],
  auth: HarnessState["auth"],
): HarnessState => ({ ...opencode(), id, signIn, auth });

test("each sign-in state offers its own control (R6, R7)", () => {
  assert.deepEqual(
    accountActions(harness("claude", "in_app", { state: "signing_in" })),
    ["cancel"],
  );
  assert.deepEqual(
    accountActions(harness("codex", "in_app", { state: "signed_out" })),
    ["sign_in"],
  );
  for (const id of ["claude", "codex"] as const)
    assert.deepEqual(
      accountActions(
        harness(id, "in_app", {
          state: "signed_in",
          account: "me@example.invalid",
          signOut: true,
        }),
      ),
      ["sign_out"],
    );
  assert.deepEqual(
    accountActions(
      harness("opencode", "command", {
        state: "signed_out",
        command: "XDG_DATA_HOME='/app' '/bin/opencode' auth login",
      }),
    ),
    ["command"],
  );
});

test("OpenCode on local models alone reads Local models and offers no Sign out (AE7)", () => {
  const local = harness("opencode", "command", {
    state: "signed_in",
    account: "Local models",
    command: "XDG_DATA_HOME='/app' '/bin/opencode' auth login",
  });
  assert.equal(authLabel(local), "Local models");
  assert.ok(!accountActions(local).includes("sign_out"));
  assert.ok(
    accountActions({
      ...local,
      auth: { ...local.auth, signOut: true },
    }).includes("sign_out"),
  );
});
