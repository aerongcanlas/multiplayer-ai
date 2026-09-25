import { FolderOpen, LogIn, RefreshCw, RotateCcw } from "lucide-react";
import type { HarnessState } from "../../shared/tabs";
import { perform } from "../lib/desktop-store";
import { authLabel, programFailed, programLabel } from "../lib/harness-status";
import { plural } from "../lib/utils";
import { Button } from "./ui/Button";

/** Setup a harness still needs: program problems, sign-in, and the Claude policy notice. */
export function HarnessStatus({
  harness,
  disabled,
  compact = false,
}: {
  harness: HarnessState;
  disabled: boolean;
  compact?: boolean;
}) {
  const { program, auth } = harness;
  const failed = programFailed(program);
  return (
    <div
      className={`harness-status ${compact ? "harness-status-compact" : ""}`}
    >
      {program.message && failed && (
        <p className="harness-problem" role="alert">
          {program.message}
        </p>
      )}
      {program.warning && <p className="subtle">{program.warning}</p>}
      {failed && program.state !== "unsupported" && (
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() =>
            void perform(() =>
              program.state === "custom_invalid"
                ? window.desktop.useManagedHarness(harness.id)
                : window.desktop.refreshHarness(harness.id),
            )
          }
        >
          <RotateCcw size={12} />
          {program.state === "custom_invalid"
            ? "Use managed program"
            : "Retry download"}
        </Button>
      )}
      {auth.state === "signed_out" &&
        (harness.signIn === "in_app" ? (
          <Button
            size="xs"
            disabled={disabled}
            onClick={() =>
              void perform(() => window.desktop.signInHarness(harness.id))
            }
          >
            <LogIn size={12} />
            Sign in with ChatGPT
          </Button>
        ) : (
          <p className="harness-guidance">{auth.message}</p>
        ))}
      {auth.state === "unknown" && auth.message && (
        <p className="subtle">{auth.message}</p>
      )}
      {harness.noticePending && (
        <div
          className="harness-notice"
          role="note"
          aria-label={`${harness.label} sign-in notice`}
        >
          <p>
            {harness.label} tabs use the Claude Code login already on this
            computer. Anthropic does not allow third-party apps to offer
            claude.ai sign-in, so this app never asks for it.
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              void perform(() =>
                window.desktop.acknowledgeHarnessNotice(harness.id),
              )
            }
          >
            Got it
          </Button>
        </div>
      )}
    </div>
  );
}

export function HarnessSettings({
  harnesses,
  disabled,
}: {
  harnesses: HarnessState[];
  disabled: boolean;
}) {
  return (
    <section
      className="shared-connection harness-settings"
      aria-label="Harness settings"
    >
      {harnesses.map((harness) => (
        <div
          className="harness-row"
          key={harness.id}
          aria-label={`${harness.label} settings`}
        >
          <div className="harness-row-heading">
            <strong>{harness.label}</strong>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Refresh ${harness.label}`}
              disabled={disabled}
              onClick={() =>
                void perform(() => window.desktop.refreshHarness(harness.id))
              }
            >
              <RefreshCw size={12} />
            </Button>
          </div>
          <span className="harness-line">{programLabel(harness)}</span>
          {harness.program.customPath && (
            <span
              className="harness-line harness-path"
              title={harness.program.customPath}
            >
              {harness.program.customPath}
            </span>
          )}
          <span className="harness-line">{authLabel(harness)}</span>
          {harness.models.length > 0 && (
            <span className="harness-line">
              {plural(harness.models.length, "model")}
            </span>
          )}
          {harness.limits.map((limit) => (
            <span className="harness-line" key={limit.name}>
              {Math.round(100 - limit.usedPercent)}% remaining · {limit.name}
            </span>
          ))}
          <HarnessStatus harness={harness} disabled={disabled} />
          <details className="harness-program">
            <summary>Program</summary>
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void perform(() =>
                  window.desktop.chooseHarnessExecutable(harness.id),
                )
              }
            >
              <FolderOpen size={12} />
              Choose executable…
            </Button>
            {harness.program.customPath && (
              <Button
                size="xs"
                variant="ghost"
                disabled={disabled}
                onClick={() =>
                  void perform(() =>
                    window.desktop.useManagedHarness(harness.id),
                  )
                }
              >
                Use managed program
              </Button>
            )}
          </details>
        </div>
      ))}
    </section>
  );
}
