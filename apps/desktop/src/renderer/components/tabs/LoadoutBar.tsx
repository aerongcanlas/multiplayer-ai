import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Hand,
  ListChecks,
  Plus,
  ShieldCheck,
  Star,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { HarnessId, HarnessState, Loadout } from "../../../shared/tabs";

const ACCESS_MODES: {
  id: Loadout["access"];
  label: string;
  description: string;
  Icon: typeof Hand;
}[] = [
  {
    id: "ask",
    label: "Ask before acting",
    description: "Approve each edit and command before it runs",
    Icon: Hand,
  },
  {
    id: "auto",
    label: "Act without asking",
    description: "Edits files and runs commands in this checkout",
    Icon: ShieldCheck,
  },
];

const HARNESS_MARKS: Record<HarnessId, ReactNode> = {
  codex: (
    <>
      <circle cx="8" cy="8" r="8" fill="#6f6bf2" />
      <path
        d="M4.6 6l2.2 2-2.2 2M8.4 10.2h3"
        fill="none"
        stroke="#fff"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  claude: (
    <path
      d="M8 1v14M1 8h14M3 3l10 10M13 3L3 13"
      fill="none"
      stroke="#d97757"
      strokeWidth="2"
      strokeLinecap="round"
    />
  ),
  opencode: (
    <>
      <rect x="1" y="1" width="14" height="14" rx="3" fill="#2b2b2b" />
      <rect
        x="4.5"
        y="4.5"
        width="7"
        height="7"
        fill="none"
        stroke="#f1ecec"
        strokeWidth="1.6"
      />
    </>
  ),
};

/** The mark of the harness a model comes from. */
export function HarnessIcon({ id }: { id: HarnessId }) {
  return (
    <svg
      className="loadout-harness-icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      {HARNESS_MARKS[id]}
    </svg>
  );
}

/** Model, effort, plan mode, and access for the next turn. Locked while a turn runs. */
export function LoadoutBar({
  loadout,
  harness,
  disabled,
  onChange,
  onSetDefault,
}: {
  loadout: Loadout;
  harness?: HarnessState;
  disabled: boolean;
  onChange: (loadout: Loadout) => void;
  onSetDefault: (model: string, effort?: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const accessRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const access =
    ACCESS_MODES.find((mode) => mode.id === loadout.access) ?? ACCESS_MODES[0]!;
  const models = harness?.models ?? [];
  const model = models.find((item) => item.id === loadout.model);
  // A model that disappeared from the harness's list must be chosen again.
  const missing = Boolean(models.length && !model);
  const efforts = model?.efforts ?? [];
  const isDefault = Boolean(
    model?.isDefault &&
    (!model.defaultEffort || model.defaultEffort === loadout.effort),
  );

  const open = menuOpen || accessOpen || modelOpen;
  useEffect(() => {
    if (!open) return;
    const close = () => {
      setMenuOpen(false);
      setAccessOpen(false);
      setModelOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target)) setMenuOpen(false);
      if (!accessRef.current?.contains(target)) setAccessOpen(false);
      if (!modelRef.current?.contains(target)) setModelOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="loadout-bar" aria-label="Tab loadout">
      <div className="loadout-group">
        <div className="loadout-menu" ref={menuRef}>
          <button
            type="button"
            className="loadout-icon-button"
            aria-label="Add"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={disabled}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
          {menuOpen && !disabled && (
            <div className="loadout-popover" role="menu" aria-label="Add">
              <button
                type="button"
                role="menuitemcheckbox"
                aria-label="Plan mode"
                aria-checked={loadout.planMode}
                className="loadout-menu-item"
                onClick={() => {
                  onChange({ ...loadout, planMode: !loadout.planMode });
                  setMenuOpen(false);
                }}
              >
                <ListChecks size={14} aria-hidden="true" />
                <span>Plan mode</span>
                {loadout.planMode && (
                  <Check
                    size={14}
                    className="loadout-menu-end"
                    aria-hidden="true"
                  />
                )}
              </button>
            </div>
          )}
        </div>
        <div className="loadout-menu" ref={accessRef}>
          <button
            type="button"
            className="loadout-chip"
            aria-label="Access"
            aria-haspopup="menu"
            aria-expanded={accessOpen}
            disabled={disabled}
            onClick={() => setAccessOpen((open) => !open)}
          >
            <access.Icon size={14} aria-hidden="true" />
            {access.label}
          </button>
          {accessOpen && !disabled && (
            <div className="loadout-popover" role="menu" aria-label="Access">
              <p className="loadout-menu-heading">
                How should actions be approved?
              </p>
              {ACCESS_MODES.map((mode) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={mode.id === loadout.access}
                  key={mode.id}
                  className="loadout-menu-item"
                  onClick={() => {
                    onChange({ ...loadout, access: mode.id });
                    setAccessOpen(false);
                  }}
                >
                  <mode.Icon size={16} aria-hidden="true" />
                  <span className="loadout-menu-text">
                    <span>{mode.label}</span>
                    <small>{mode.description}</small>
                  </span>
                  {mode.id === loadout.access && (
                    <Check
                      size={14}
                      className="loadout-menu-end"
                      aria-hidden="true"
                    />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        {loadout.planMode && (
          <span className="loadout-chip loadout-plan">
            <ListChecks size={14} aria-hidden="true" />
            Plan
          </span>
        )}
      </div>
      <div className="loadout-group">
        <div className="loadout-menu" ref={modelRef}>
          <button
            type="button"
            className={`loadout-chip loadout-model${missing ? " loadout-missing" : ""}`}
            aria-label="Model"
            aria-haspopup="menu"
            aria-expanded={modelOpen}
            disabled={disabled || !models.length}
            onClick={() => {
              setModelOpen((open) => !open);
              setEffortOpen(false);
            }}
          >
            {missing && <AlertTriangle size={12} aria-hidden="true" />}
            <span className="loadout-model-name">
              {missing
                ? "Choose a model"
                : (model?.name ?? "Waiting for models…")}
            </span>
            {loadout.effort && efforts.length > 0 && (
              <span className="loadout-effort">{loadout.effort}</span>
            )}
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          {modelOpen && !disabled && (
            <div
              className="loadout-popover loadout-model-menu"
              role="menu"
              aria-label="Model"
            >
              {missing && (
                <p className="loadout-menu-note">
                  {loadout.model} is unavailable — choose a model
                </p>
              )}
              {models.map((item) => {
                const selected = item.id === loadout.model;
                if (item.hidden && !selected) return null;
                const effort = selected
                  ? loadout.effort
                  : (item.defaultEffort ?? item.efforts[0]);
                return (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    key={item.id}
                    className="loadout-menu-item"
                    onClick={() => {
                      // A model starts at the effort its row shows.
                      const next = item.defaultEffort ?? item.efforts[0];
                      onChange({
                        ...loadout,
                        model: item.id,
                        ...(next ? { effort: next } : { effort: undefined }),
                      });
                      setModelOpen(false);
                    }}
                  >
                    <HarnessIcon id={loadout.harness} />
                    <span className="loadout-model-name">{item.name}</span>
                    {effort && <span className="loadout-effort">{effort}</span>}
                    {selected && (
                      <Check
                        size={14}
                        className="loadout-menu-end"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
              {efforts.length > 0 && (
                <>
                  <hr />
                  <button
                    type="button"
                    role="menuitem"
                    className="loadout-menu-item"
                    aria-label="Effort"
                    aria-expanded={effortOpen}
                    onClick={() => setEffortOpen((open) => !open)}
                  >
                    <span>Effort</span>
                    <span className="loadout-effort loadout-menu-end">
                      {loadout.effort}
                    </span>
                    <ChevronRight
                      size={14}
                      className={effortOpen ? "loadout-chevron-open" : ""}
                      aria-hidden="true"
                    />
                  </button>
                  {effortOpen && (
                    <div role="group" aria-label="Effort levels">
                      {efforts.map((effort) => (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={effort === loadout.effort}
                          key={effort}
                          className="loadout-menu-item loadout-menu-sub"
                          onClick={() => {
                            onChange({ ...loadout, effort });
                            setModelOpen(false);
                          }}
                        >
                          <span className="loadout-effort">{effort}</span>
                          {effort === loadout.effort && (
                            <Check
                              size={14}
                              className="loadout-menu-end"
                              aria-hidden="true"
                            />
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
              {model && (
                <>
                  <hr />
                  <button
                    type="button"
                    role="menuitem"
                    className="loadout-menu-item loadout-menu-default"
                    disabled={isDefault}
                    onClick={() => {
                      onSetDefault(model.id, loadout.effort);
                      setModelOpen(false);
                    }}
                  >
                    <Star size={13} aria-hidden="true" />
                    {isDefault ? "Default for new tabs" : "Set as default"}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
