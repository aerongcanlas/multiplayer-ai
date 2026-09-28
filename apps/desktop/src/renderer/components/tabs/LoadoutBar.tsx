import { AlertTriangle } from "lucide-react";
import type { HarnessState, Loadout } from "../../../shared/tabs";

/** Model, effort, plan mode, and access for the next turn. Locked while a turn runs. */
export function LoadoutBar({
  loadout,
  harness,
  disabled,
  onChange,
}: {
  loadout: Loadout;
  harness?: HarnessState;
  disabled: boolean;
  onChange: (loadout: Loadout) => void;
}) {
  const models = harness?.models ?? [];
  const model = models.find((item) => item.id === loadout.model);
  // A model that disappeared from the harness's list must be chosen again.
  const missing = Boolean(models.length && !model);
  const efforts = model?.efforts ?? [];
  return (
    <div className="loadout-bar" aria-label="Tab loadout">
      <label className={missing ? "loadout-missing" : ""}>
        Model
        <select
          aria-label="Model"
          aria-invalid={missing}
          disabled={disabled || !models.length}
          value={missing ? "" : loadout.model}
          onChange={(event) => {
            const next = models.find((item) => item.id === event.target.value);
            if (!next) return;
            const effort =
              loadout.effort && next.efforts.includes(loadout.effort)
                ? loadout.effort
                : (next.defaultEffort ?? next.efforts[0]);
            onChange({
              ...loadout,
              model: next.id,
              ...(effort ? { effort } : { effort: undefined }),
            });
          }}
        >
          {missing && (
            <option value="" disabled>
              {loadout.model} is unavailable — choose a model
            </option>
          )}
          {!models.length && <option value="">Waiting for models…</option>}
          {models.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        {missing && <AlertTriangle size={12} aria-hidden="true" />}
      </label>
      {efforts.length > 0 && (
        <label>
          Effort
          <select
            aria-label="Effort"
            disabled={disabled}
            value={loadout.effort ?? ""}
            onChange={(event) =>
              onChange({ ...loadout, effort: event.target.value })
            }
          >
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="loadout-toggle">
        <input
          type="checkbox"
          aria-label="Plan mode"
          disabled={disabled}
          checked={loadout.planMode}
          onChange={(event) =>
            onChange({ ...loadout, planMode: event.target.checked })
          }
        />
        Plan mode
      </label>
      <label>
        Access
        <select
          aria-label="Access"
          disabled={disabled}
          value={loadout.access}
          onChange={(event) =>
            onChange({
              ...loadout,
              access: event.target.value as Loadout["access"],
            })
          }
        >
          <option value="ask">Ask before acting</option>
          <option value="auto">Act without asking</option>
        </select>
      </label>
    </div>
  );
}
