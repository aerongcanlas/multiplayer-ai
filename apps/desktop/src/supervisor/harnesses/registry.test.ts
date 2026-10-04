import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessRegistry } from "./registry";
import { FakeHarness } from "./fake";
import { ProgramManager } from "../programs/manager";
import { HARNESS_MANIFEST } from "../programs/manifest";

async function registry(adapters: FakeHarness[]) {
  const settings = new Map<string, unknown>();
  const root = await mkdtemp(join(tmpdir(), "multiplayer-registry-"));
  return new HarnessRegistry({
    adapters,
    programs: new ProgramManager({ root, manifest: HARNESS_MANIFEST }),
    settings: {
      getSetting: <T>(key: string) => settings.get(key) as T | undefined,
      setSetting: (key, value) => settings.set(key, value),
    },
    changed: () => {},
    environmentTimeoutMs: 0,
  });
}

test("a registry without OpenCode reports and offers only its own harnesses", async () => {
  const harnesses = await registry([
    new FakeHarness("codex"),
    new FakeHarness("claude", { signIn: "guidance" }),
  ]);
  try {
    assert.deepEqual(
      harnesses.snapshot().map((state) => state.id),
      ["codex", "claude"],
    );
    assert.throws(() => harnesses.state("opencode"), /not available/);
    assert.equal(harnesses.newTabHarness(), "claude");
    assert.throws(() => harnesses.setNewTabHarness("opencode"), /not available/);
  } finally {
    harnesses.close();
  }
});

test("only a harness with a notice starts with it pending", async () => {
  const harnesses = await registry([
    new FakeHarness("claude", { signIn: "guidance" }),
    new FakeHarness("opencode", { signIn: "guidance" }),
  ]);
  try {
    assert.equal(harnesses.state("claude").noticePending, true);
    assert.equal(harnesses.state("opencode").noticePending, false);
    assert.equal(harnesses.state("opencode").label, "OpenCode");
  } finally {
    harnesses.close();
  }
});
