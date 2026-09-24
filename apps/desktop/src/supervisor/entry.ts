import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Journal } from "./journal";
import { SupervisorService } from "./service";
import { HarnessRegistry } from "./harnesses/registry";
import { CodexAdapter } from "./harnesses/codex/adapter";
import { ClaudeAdapter } from "./harnesses/claude/adapter";
import { claudeFixture } from "./harnesses/claude/fixture";
import { ProgramManager } from "./programs/manager";
import { HARNESS_MANIFEST } from "./programs/manifest";
import type { SupervisorMessage, SupervisorRequest } from "../shared/contracts";

// Electron utilityProcess exposes parentPort, never a renderer-facing Node connection.
const parent = (
  process as NodeJS.Process & {
    parentPort: {
      postMessage(message: SupervisorMessage): void;
      on(
        event: "message",
        listener: (event: { data: SupervisorRequest }) => void,
      ): void;
    };
  }
).parentPort;
const directory = process.argv[2];
const fixture = process.argv[3];
const claudeFixturePath = process.argv[4];
if (!parent || !directory)
  throw new Error("Supervisor must be launched by the desktop host.");
mkdirSync(directory, { recursive: true });
const journal = new Journal(join(directory, "execution-journal.sqlite"));
// Harness state changes reach the service once it exists.
let harnessesChanged = () => {};
// Fixtures are passed only by an unpackaged E2E launch; they run under Electron's Node.
const fixtureLauncher =
  (script: string) =>
  (_executable: string, args: string[], env: Record<string, string>) => ({
    executable: process.execPath,
    args: [script, ...args],
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
  });
const registry = new HarnessRegistry({
  adapters: [
    new CodexAdapter(fixture ? { launcher: fixtureLauncher(fixture) } : {}),
    new ClaudeAdapter(
      claudeFixturePath ? claudeFixture(claudeFixturePath).options : {},
    ),
  ],
  programs: new ProgramManager({ root: directory, manifest: HARNESS_MANIFEST }),
  settings: journal,
  changed: () => harnessesChanged(),
  openLogin: (harness, url) =>
    parent.postMessage({ type: "open-login", harness, url }),
});
const supervisor = new SupervisorService(
  journal,
  (snapshot) => parent.postMessage({ type: "snapshot", snapshot }),
  {
    registry,
    publishTranscript: (batches) =>
      parent.postMessage({ type: "transcript", batches }),
  },
);
harnessesChanged = () => supervisor.harnessesChanged();
parent.postMessage({ type: "ready", snapshot: supervisor.snapshot() });
const heartbeat = setInterval(
  () => parent.postMessage({ type: "heartbeat" }),
  2_000,
);
let pending = Promise.resolve();
parent.on("message", ({ data }) => {
  pending = pending.then(async () => {
    try {
      // Harness I/O runs as background jobs, so a slow refresh never holds this queue (KTD16).
      const result = await supervisor.dispatchResult(data.command);
      parent.postMessage({
        type: "response",
        id: data.id,
        result: { ok: true, ...result },
      });
    } catch (error) {
      parent.postMessage({
        type: "response",
        id: data.id,
        result: {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "The local operation failed.",
        },
      });
    }
  });
});
process.on("exit", () => {
  clearInterval(heartbeat);
  supervisor.close();
});
