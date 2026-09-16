import type { ProviderState, RunConfiguration } from "../../shared/provider";

export function RunControls({
  runner,
  onRunner,
  provider,
  configuration,
  onConfiguration,
  disabled,
}: {
  runner: "mock" | "codex";
  onRunner: (runner: "mock" | "codex") => void;
  provider?: ProviderState;
  configuration: RunConfiguration;
  onConfiguration: (configuration: RunConfiguration) => void;
  disabled: boolean;
}) {
  const model = provider?.models.find(
    (item) => item.id === configuration.model,
  );
  return (
    <details className="run-settings">
      <summary>
        Run settings{" "}
        <span>
          {runner === "codex"
            ? `${model?.name ?? "Codex"} · ${configuration.mode === "read-only" ? "Read-only" : "Isolated worktrees"}`
            : "Mock simulation"}
        </span>
      </summary>
      <div className="run-controls">
        <label>
          Runner
          <select
            aria-label="Agent runner"
            value={runner}
            disabled={disabled}
            onChange={(event) =>
              onRunner(event.target.value as "mock" | "codex")
            }
          >
            <option value="codex">Codex · ChatGPT</option>
            <option value="mock">Mock · simulation</option>
          </select>
        </label>
        {runner === "codex" && (
          <>
            <label>
              Model
              <select
                aria-label="Agent model"
                value={configuration.model}
                disabled={disabled || provider?.status !== "connected"}
                onChange={(event) => {
                  const selected = provider?.models.find(
                    (item) => item.id === event.target.value,
                  );
                  onConfiguration({
                    ...configuration,
                    model: event.target.value,
                    effort: (selected?.defaultEffort ??
                      "medium") as RunConfiguration["effort"],
                  });
                }}
              >
                {!model && <option value="">Connect ChatGPT</option>}
                {provider?.models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Reasoning
              <select
                aria-label="Agent reasoning"
                value={configuration.effort}
                disabled={disabled || !model}
                onChange={(event) =>
                  onConfiguration({
                    ...configuration,
                    effort: event.target.value as RunConfiguration["effort"],
                  })
                }
              >
                {(model?.efforts ?? ["medium"])
                  .filter((effort) =>
                    ["low", "medium", "high", "xhigh", "max"].includes(effort),
                  )
                  .map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Access
              <select
                aria-label="Agent access"
                value={configuration.mode}
                disabled={disabled}
                onChange={(event) =>
                  onConfiguration({
                    ...configuration,
                    mode: event.target.value as RunConfiguration["mode"],
                  })
                }
              >
                <option value="read-only">Read-only</option>
                <option value="worktree">Edit isolated worktrees</option>
              </select>
            </label>
            <label>
              Parallel agents
              <select
                aria-label="Parallel agents"
                value={configuration.concurrency}
                disabled={disabled}
                onChange={(event) =>
                  onConfiguration({
                    ...configuration,
                    concurrency: Number(event.target.value),
                  })
                }
              >
                {[1, 2, 3].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
    </details>
  );
}
