import type { SupervisorTesting } from "../shared/contracts";
import { ClaudeAdapter } from "./harnesses/claude/adapter";
import { CodexAdapter } from "./harnesses/codex/adapter";
import type { HarnessAdapter } from "./harnesses/contract";
import { OpenCodeAdapter } from "./harnesses/opencode/adapter";

// Fixtures are passed only by an unpackaged E2E launch; they run under Electron's Node.
const fixtureLauncher =
  (script: string) =>
  (_executable: string, args: string[], env: Record<string, string>) => ({
    executable: process.execPath,
    args: [script, ...args],
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
  });

// What OpenCode finds when neither local server is running.
const NO_LOCAL_SERVERS = {
  servers: [
    { id: "ollama" as const, label: "Ollama", running: false, models: [] },
    { id: "lmstudio" as const, label: "LM Studio", running: false, models: [] },
  ],
  providers: [],
};

/** Every harness this build ships, with any E2E fixtures swapped in by name. */
export async function harnessAdapters(
  testing: SupervisorTesting,
): Promise<HarnessAdapter[]> {
  return [
    new CodexAdapter(
      testing.codexFixture
        ? { launcher: fixtureLauncher(testing.codexFixture) }
        : {},
    ),
    // The Claude fixture is loaded only for an E2E run, so the shipped bundle never evaluates it.
    new ClaudeAdapter(
      testing.claudeFixture
        ? (await import("./harnesses/claude/fixture")).claudeFixture(
            testing.claudeFixture,
          ).options
        : {},
    ),
    // A fixture run reports its own local servers instead of probing the real ones; a live run
    // may do the same to check the no-local-server state.
    new OpenCodeAdapter({
      ...(testing.opencodeFixture
        ? { launcher: fixtureLauncher(testing.opencodeFixture) }
        : {}),
      ...(testing.opencodeFixture || testing.opencodeDiscovery
        ? {
            discover: async () => testing.opencodeDiscovery ?? NO_LOCAL_SERVERS,
          }
        : {}),
    }),
  ];
}
