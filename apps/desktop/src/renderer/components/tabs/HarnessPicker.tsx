import { Check, ChevronRight, Plus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  HARNESS_IDS,
  HARNESS_LABELS,
  type HarnessId,
  type HarnessState,
} from "../../../shared/tabs";
import { Button } from "../ui/Button";

/** One line telling whether a harness can start a tab right away. */
function readiness(harness: HarnessState | undefined) {
  if (!harness) return { ready: false, text: "Checking…" };
  const { program, auth } = harness;
  if (["failed", "custom_invalid", "unsupported"].includes(program.state))
    return { ready: false, text: "Program needs attention" };
  if (program.state === "downloading")
    return {
      ready: false,
      text: `Downloading… ${Math.round((program.progress ?? 0) * 100)}%`,
    };
  if (auth.state === "signed_out")
    return { ready: false, text: "Sign in required" };
  if (program.state === "missing")
    return { ready: true, text: "Installs on first use" };
  const models = harness.models.length;
  return {
    ready: true,
    text: models
      ? `Ready · ${models} model${models === 1 ? "" : "s"}`
      : "Ready",
  };
}

/** The "+" button that opens a new chat tab, with a keyboard-navigable harness menu. */
export function HarnessPicker({
  harnesses,
  disabled,
  onPick,
}: {
  harnesses: HarnessState[];
  disabled: boolean;
  onPick: (id: HarnessId) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    items.current[0]?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }
  function onMenuKey(event: React.KeyboardEvent) {
    const list = items.current.filter(Boolean) as HTMLButtonElement[];
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number) => {
      event.preventDefault();
      list[(next + list.length) % list.length]?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(list.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") close(false);
  }

  return (
    <div className="tab-new" ref={root}>
      <Button
        ref={trigger}
        size="icon-sm"
        variant="ghost"
        className="tab-new-trigger"
        aria-label="New tab"
        title="New tab"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Plus size={15} />
      </Button>
      {open && (
        <div
          id={menuId}
          className="tab-picker"
          role="menu"
          aria-label="Open a new tab with"
          onKeyDown={onMenuKey}
        >
          <p className="tab-picker-heading" aria-hidden="true">
            New tab
          </p>
          {HARNESS_IDS.map((id, index) => {
            const harness = harnesses.find((item) => item.id === id);
            const state = readiness(harness);
            return (
              <button
                type="button"
                role="menuitem"
                key={id}
                ref={(node) => {
                  items.current[index] = node;
                }}
                className="tab-picker-item"
                aria-labelledby={`${menuId}-${id}-label`}
                aria-describedby={`${menuId}-${id}-state`}
                onClick={() => {
                  close(false);
                  onPick(id);
                }}
              >
                <span
                  className={`tab-picker-mark harness-${id}`}
                  aria-hidden="true"
                >
                  {HARNESS_LABELS[id].charAt(0)}
                </span>
                <span className="tab-picker-text">
                  <span
                    id={`${menuId}-${id}-label`}
                    className="tab-picker-label"
                  >
                    {HARNESS_LABELS[id]}
                  </span>
                  <span
                    id={`${menuId}-${id}-state`}
                    className={`tab-picker-state ${state.ready ? "is-ready" : "is-blocked"}`}
                  >
                    {state.ready && <Check size={11} aria-hidden="true" />}
                    {state.text}
                  </span>
                </span>
                <ChevronRight
                  size={14}
                  className="tab-picker-chevron"
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
