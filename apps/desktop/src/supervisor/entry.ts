import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { Journal } from "./journal";
import { SupervisorService } from "./service";
import { HarnessRegistry } from "./harnesses/registry";
import { Accounts } from "./harnesses/accounts";
import { harnessAdapters } from "./adapters";
import { ProgramManager } from "./programs/manager";
import { HARNESS_MANIFEST } from "./programs/manifest";
import { latestVersion } from "./programs/latest";
import { findRelease } from "./programs/release";
import type { ProgramManifest } from "./programs/types";
import type {
  SupervisorMessage,
  SupervisorRequest,
  SupervisorTesting,
} from "../shared/contracts";

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
// Fixtures and a local manifest, set only by an unpackaged E2E launch.
const testing = JSON.parse(process.argv[3] || "{}") as SupervisorTesting;
// App-owned harness homes; empty leaves every harness unavailable rather than using the host's.
const accountsRoot = process.argv[4] || undefined;
// An E2E run may point managed downloads at a local server.
const manifest = testing.harnessManifest
  ? (JSON.parse(
      readFileSync(testing.harnessManifest, "utf8"),
    ) as ProgramManifest)
  : HARNESS_MANIFEST;
if (!parent || !directory)
  throw new Error("Supervisor must be launched by the desktop host.");
mkdirSync(directory, { recursive: true });
const journal = new Journal(join(directory, "execution-journal.sqlite"));
// Harness state changes reach the service once it exists.
let harnessesChanged = () => {};
let supervisor: SupervisorService | undefined;
const started = (async () => {
  const registry = new HarnessRegistry({
    adapters: await harnessAdapters(testing),
    programs: new ProgramManager({ root: directory, manifest }),
    accounts: new Accounts(accountsRoot),
    settings: journal,
    changed: () => harnessesChanged(),
    // An E2E run stays offline.
    ...(Object.values(testing).some(Boolean)
      ? {}
      : { latest: latestVersion, release: findRelease }),
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
  // Generation waits on the model and a command list on the harness; other commands, including
  // Stop, keep flowing.
  if (["suggestion.create", "tab.commands"].includes(data.command.type))
    void pending.then(respond);
  else pending = pending.then(respond);
});
process.on("exit", () => {
  clearInterval(heartbeat);
  supervisor?.close();
});
