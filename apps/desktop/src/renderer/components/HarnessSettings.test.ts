import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HarnessState } from "../../shared/tabs";

// The shared UI package compiles outside this app's tsconfig, with the classic JSX runtime.
Object.assign(globalThis, { React });
const { HarnessConnection } = await import("./HarnessSettings");

const claude = (auth: HarnessState["auth"]): HarnessState => ({
  id: "claude",
  label: "Claude Code",
  program: { state: "ready", version: "2.1.288", pinned: "2.1.288" },
  auth,
  signIn: "in_app",
  models: [],
  modelsRefreshedAt: null,
  limits: [],
  reportsAgents: true,
  noticePending: false,
});
const render = (harness: HarnessState) =>
  renderToStaticMarkup(
    React.createElement(HarnessConnection, { harness, disabled: false }),
  );

test("a linked-config credential warning shows under the status (R14)", () => {
  const html = render(
    claude({
      state: "signed_in",
      account: "me@example.invalid",
      plan: "max",
      signOut: true,
      warning:
        "Your Claude Code settings set apiKeyHelper, so Claude Code tabs use that credential instead of this app's sign-in.",
    }),
  );
  assert.match(html, /me@example\.invalid · max/);
  assert.match(html, /settings set apiKeyHelper/);
  assert.match(html, /Sign out/);
});

test("a pending sign-in offers Cancel, and OpenCode shows its command", () => {
  assert.match(render(claude({ state: "signing_in" })), /Cancel sign-in/);
  const html = render({
    ...claude({
      state: "signed_out",
      message: "No models available.",
      command: "XDG_DATA_HOME='/app/opencode' '/bin/opencode' auth login",
    }),
    id: "opencode",
    label: "OpenCode",
    signIn: "command",
  });
  assert.match(html, /auth login/);
  assert.match(html, /Copy/);
  assert.doesNotMatch(html, /Sign out/);
});
