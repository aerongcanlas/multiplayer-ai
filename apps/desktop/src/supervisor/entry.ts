import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Journal } from "./journal";
import { SupervisorService } from "./service";
import { CodexClient } from "./codex-client";
import { CodexRunner } from "./codex-runner";
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
if (!parent || !directory)
  throw new Error("Supervisor must be launched by the desktop host.");
mkdirSync(directory, { recursive: true });
const service = new SupervisorService(
  new Journal(join(directory, "execution-journal.sqlite")),
  (snapshot) => parent.postMessage({ type: "snapshot", snapshot }),
  undefined,
  new CodexRunner(
    new CodexClient({
      cwd: directory,
      ...(fixture
        ? {
            executable: process.execPath,
            args: [fixture],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          }
        : {}),
    }),
    join(directory, "worktrees"),
  ),
  (url) => parent.postMessage({ type: "open-provider-login", url }),
);
parent.postMessage({ type: "ready", snapshot: service.snapshot() });
const heartbeat = setInterval(
  () => parent.postMessage({ type: "heartbeat" }),
  2_000,
);
let pending = Promise.resolve();
parent.on("message", ({ data }) => {
  pending = pending.then(async () => {
    try {
      const snapshot = await service.dispatch(data.command);
      parent.postMessage({
        type: "response",
        id: data.id,
        result: { ok: true, snapshot },
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
  service.close();
});
