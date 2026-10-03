import { Boxes, UserRound } from "lucide-react";
import { useState, type RefObject } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@multiplayer-ai/ui/primitives/dialog";
import type { HarnessId, HarnessState } from "../../shared/tabs";
import { perform, useDesktop } from "../lib/desktop-store";
import { readiness } from "../lib/harness-status";
import { HarnessConnection } from "./HarnessSettings";
import { AccountSettings } from "./SharedConnection";
import { HarnessIcon } from "./tabs/LoadoutBar";
import { Button } from "./ui/Button";

/** The harness's models: which show in the tab model picker, and which new tabs start on. */
function Models({
  harness,
  disabled,
}: {
  harness: HarnessState;
  disabled: boolean;
}) {
  const shown = harness.models.filter((model) => !model.hidden).length;
  return (
    <section className="settings-section" aria-label="Models">
      <h3>
        Models
        {harness.models.length > 0 && (
          <small>
            {shown} of {harness.models.length} in the model picker
          </small>
        )}
      </h3>
      {harness.models.length ? (
        <ul className="settings-rows settings-models">
          {harness.models.map((model) => (
            <li key={model.id}>
              <span className="settings-model-name">
                {model.name}
                <small>
                  {[model.id, model.efforts.join(" · ")]
                    .filter(Boolean)
                    .join(" — ")}
                </small>
              </span>
              {model.isDefault ? (
                <span className="settings-default">Default for new tabs</span>
              ) : (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() =>
                    void perform(() =>
                      window.desktop.setHarnessDefault(harness.id, model.id),
                    )
                  }
                >
                  Set as default
                </Button>
              )}
              <label
                className="read-along-switch"
                title={
                  model.isDefault
                    ? "The default model always shows in the model picker."
                    : undefined
                }
              >
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`Show ${model.name} in the model picker`}
                  checked={!model.hidden}
                  disabled={disabled || model.isDefault}
                  onChange={() =>
                    void perform(() =>
                      window.desktop.setHarnessModelHidden(
                        harness.id,
                        model.id,
                        !model.hidden,
                      ),
                    )
                  }
                />
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-note">
          Models appear once {harness.label} is ready and signed in.
        </p>
      )}
    </section>
  );
}

function OutputStyle({
  harness,
  disabled,
}: {
  harness: HarnessState;
  disabled: boolean;
}) {
  if (!harness.outputStyles?.length) return null;
  // A saved style the harness no longer offers still shows as the choice.
  const styles =
    harness.outputStyle && !harness.outputStyles.includes(harness.outputStyle)
      ? [harness.outputStyle, ...harness.outputStyles]
      : harness.outputStyles;
  return (
    <section className="settings-section" aria-label="Output style">
      <h3>Output style</h3>
      <div className="settings-rows">
        <label className="settings-field">
          <span className="settings-field-text">
            Response style
            <small>
              How {harness.label} writes its responses. Applies to tabs opened
              or reopened after the change.
            </small>
          </span>
          <select
            aria-label="Output style"
            value={harness.outputStyle ?? ""}
            disabled={disabled}
            onChange={(event) =>
              void perform(() =>
                window.desktop.setHarnessOutputStyle(
                  harness.id,
                  event.target.value || null,
                ),
              )
            }
          >
            <option value="">{harness.label}'s own setting</option>
            {styles.map((style) => (
              <option key={style} value={style}>
                {style}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}

/** Which harness Cmd/Ctrl+T opens a tab with. */
function NewTabs({
  harnesses,
  disabled,
}: {
  harnesses: HarnessState[];
  disabled: boolean;
}) {
  const current = useDesktop().snapshot?.newTabHarness;
  return (
    <div className="settings-rows">
      <label className="settings-field">
        <span className="settings-field-text">
          New tabs open with
          <small>
            Used by Cmd/Ctrl+T. The + button in the tab bar still offers every
            harness.
          </small>
        </span>
        <select
          aria-label="New tabs open with"
          value={current ?? ""}
          disabled={disabled}
          onChange={(event) =>
            void perform(() =>
              window.desktop.setNewTabHarness(event.target.value as HarnessId),
            )
          }
        >
          {harnesses.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** The Models page: a harness's connection, its models, and its response style. */
function ModelsPage({
  harnesses,
  disabled,
}: {
  harnesses: HarnessState[];
  disabled: boolean;
}) {
  const [selected, setSelected] = useState<HarnessId | undefined>(
    harnesses[0]?.id,
  );
  const harness =
    harnesses.find((item) => item.id === selected) ?? harnesses[0];
  if (!harness)
    return (
      <p className="settings-note">Harnesses are unavailable in this build.</p>
    );
  return (
    <>
      <NewTabs harnesses={harnesses} disabled={disabled} />
      <div className="settings-harnesses" role="tablist" aria-label="Harness">
        {harnesses.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`settings-tab-${item.id}`}
            aria-selected={item.id === harness.id}
            aria-controls="settings-harness"
            title={readiness(item).text}
            onClick={() => setSelected(item.id)}
          >
            <HarnessIcon id={item.id} />
            {item.label}
            <span
              className={`status-dot ${readiness(item).ready ? "live" : "stale"}`}
            />
          </button>
        ))}
      </div>
      <div
        className="settings-sections"
        role="tabpanel"
        id="settings-harness"
        aria-labelledby={`settings-tab-${harness.id}`}
      >
        <section className="settings-section" aria-label="Harness settings">
          <h3>Connection</h3>
          <div className="settings-rows">
            <HarnessConnection harness={harness} disabled={disabled} />
          </div>
        </section>
        <Models harness={harness} disabled={disabled} />
        <OutputStyle harness={harness} disabled={disabled} />
      </div>
    </>
  );
}

const PAGES = [
  { id: "models", label: "Models", Icon: Boxes },
  { id: "account", label: "Account", Icon: UserRound },
] as const;

export function SettingsDialog({
  harnesses,
  disabled,
  onClose,
  triggerRef,
}: {
  harnesses: HarnessState[];
  disabled: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { error, snapshot } = useDesktop();
  const [page, setPage] = useState<(typeof PAGES)[number]["id"]>("models");
  const current = PAGES.find((item) => item.id === page)!;
  return (
    <Dialog
      defaultOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="settings-dialog" finalFocus={triggerRef}>
        <nav className="settings-nav" aria-label="Settings pages">
          <DialogTitle className="settings-nav-heading">Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Models, harness connections, and response style on this desktop.
          </DialogDescription>
          {PAGES.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={id === page ? "page" : undefined}
              onClick={() => setPage(id)}
            >
              <Icon size={15} aria-hidden="true" />
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-page">
          <h2>{current.label}</h2>
          {error && (
            <p className="room-entry-error" role="alert">
              {error}
            </p>
          )}
          {page === "models" && (
            <ModelsPage harnesses={harnesses} disabled={disabled} />
          )}
          {page === "account" && (
            <AccountSettings
              connection={snapshot?.collaboration}
              disabled={disabled}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
