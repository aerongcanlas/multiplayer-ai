import type { TaskStatus } from "../shared/contracts";

export interface RunnerUpdate {
  taskIndex: number;
  status: TaskStatus;
  message: string;
  evidence?: { outcome: "passed" | "failed"; detail: string };
}

// Provider sessions stay behind this interface; scheduling and persistence belong to the app.
export interface RunnerAdapter {
  readonly id: string;
  run(input: {
    prompt: string;
    scenario: "success" | "validation-failure";
    signal: AbortSignal;
  }): AsyncIterable<RunnerUpdate>;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class MockRunner implements RunnerAdapter {
  readonly id = "mock";
  constructor(private intervalMs = 700) {}

  async *run({
    scenario,
    signal,
  }: Parameters<RunnerAdapter["run"]>[0]): AsyncIterable<RunnerUpdate> {
    const updates: RunnerUpdate[] = [
      {
        taskIndex: 0,
        status: "running",
        message:
          "Lead opened the simulated plan. No repository files will be changed.",
      },
      {
        taskIndex: 1,
        status: "running",
        message:
          "Planner is demonstrating a bounded assignment and completion criteria.",
      },
      {
        taskIndex: 1,
        status: "completed",
        message:
          "Simulated plan recorded: prepare a change, then request independent validation.",
      },
      {
        taskIndex: 2,
        status: "running",
        message:
          "Implementer is simulating work. No commands, worktrees, or patches are created.",
      },
      {
        taskIndex: 2,
        status: "completed",
        message:
          "Simulated implementation finished. A real runner must return an actual patch.",
      },
      {
        taskIndex: 3,
        status: "running",
        message: "Validator is exercising the selected mock outcome.",
      },
      {
        taskIndex: 3,
        status: scenario === "success" ? "completed" : "failed",
        message:
          scenario === "success"
            ? "Mock validation passed. This is simulated evidence, not a repository check."
            : "Mock validation failed. The failure remains visible for review.",
        evidence: {
          outcome: scenario === "success" ? "passed" : "failed",
          detail:
            scenario === "success"
              ? "Deterministic mock scenario produced its expected success result. No repository tests were executed."
              : "Deterministic mock scenario produced its expected failure result. No repository tests were executed.",
        },
      },
      {
        taskIndex: 0,
        status: scenario === "success" ? "completed" : "failed",
        message:
          scenario === "success"
            ? "Simulation complete. Lead published a new context summary."
            : "Lead stopped integration after simulated validation failure.",
      },
    ];
    for (const update of updates) {
      await delay(this.intervalMs, signal);
      yield update;
    }
  }
}
