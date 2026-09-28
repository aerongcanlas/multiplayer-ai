import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { Journal } from "./journal";
import { SupervisorService } from "./service";
import { HarnessRegistry } from "./harnesses/registry";
import { CodexAdapter } from "./harnesses/codex/adapter";
import { ClaudeAdapter } from "./harnesses/claude/adapter";
import { ProgramManager } from "./programs/manager";
import { HARNESS_MANIFEST } from "./programs/manifest";
import type { ProgramManifest } from "./programs/types";
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
// An E2E run may point managed downloads at a local server.
const manifest = process.argv[5]
  ? (JSON.parse(readFileSync(process.argv[5], "utf8")) as ProgramManifest)
  : HARNESS_MANIFEST;
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
let supervisor: SupervisorService | undefined;
// The Claude fixture is loaded only for an E2E run, so the shipped bundle never evaluates it.
const started = (async () => {
  const registry = new HarnessRegistry({
    adapters: [
      new CodexAdapter(fixture ? { launcher: fixtureLauncher(fixture) } : {}),
      new ClaudeAdapter(
        claudeFixturePath
          ? (await import("./harnesses/claude/fixture")).claudeFixture(
              claudeFixturePath,
            ).options
          : {},
      ),
    ],
    programs: new ProgramManager({ root: directory, manifest }),
    settings: journal,
    changed: () => harnessesChanged(),
    openLogin: (harness, url) =>
      parent.postMessage({ type: "open-login", harness, url }),
  });
  supervisor = new SupervisorService(
    journal,
    (snapshot) => parent.postMessage({ type: "snapshot", snapshot }),
    {
      registry,
      publishTranscript: (batches) =>
        parent.postMessage({ type: "transcript", batches }),
    },
  );
  harnessesChanged = () => supervisor?.harnessesChanged();
  parent.postMessage({ type: "ready", snapshot: supervisor.snapshot() });
})();
const heartbeat = setInterval(
  () => parent.postMessage({ type: "heartbeat" }),
  2_000,
);
let pending: Promise<unknown> = started;
parent.on("message", ({ data }) => {
  const respond = async () => {
    try {
      // Harness I/O runs as background jobs, so a slow refresh never holds this queue.
      await started;
      const result = await supervisor!.dispatchResult(data.command);
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
  };
  // Generation waits on the model; other commands, including Stop, keep flowing.
  if (data.command.type === "suggestion.create") void pending.then(respond);
  else pending = pending.then(respond);
});
process.on("exit", () => {
  clearInterval(heartbeat);
  supervisor?.close();
});
