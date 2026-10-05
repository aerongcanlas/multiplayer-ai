import { useState } from "react";
import {
  ArrowUpCircle,
  Copy,
  FolderOpen,
  LogIn,
  LogOut,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import type { Result } from "../../shared/contracts";
import {
  HARNESS_NOTICES,
  tabBusy,
  type HarnessId,
  type HarnessState,
} from "../../shared/tabs";
import { perform, useDesktop } from "../lib/desktop-store";
import {
  accountActions,
  authLabel,
  programFailed,
  programLabel,
  serverLine,
  updateAvailable,
} from "../lib/harness-status";
import { Button } from "./ui/Button";

/** A click handler for one harness command, keyed so a second click waits for the first. */
const act =
  (
    { id }: HarnessState,
    key: string,
    call: (id: HarnessId) => Promise<Result>,
  ) =>
  () =>
    void perform(() => call(id), { key: `harness.${key}:${id}` });

/** Setup a harness still needs: program problems, sign-in, and a harness's one-time notice. */
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
  const actions = accountActions(harness);
  const notice = harness.noticePending && HARNESS_NOTICES[harness.id];
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
          onClick={act(harness, "program", (id) =>
            program.state === "custom_invalid"
              ? window.desktop.useManagedHarness(id)
              : window.desktop.refreshHarness(id),
          )}
        >
          <RotateCcw size={12} />
          {program.state === "custom_invalid"
            ? "Use managed program"
            : "Retry download"}
        </Button>
      )}
      {auth.state === "signed_out" && auth.message && (
        <p className="harness-guidance">{auth.message}</p>
      )}
      {actions.includes("sign_in") && (
        <Button
          size="xs"
          disabled={disabled}
          onClick={act(harness, "signIn", (id) =>
            window.desktop.signInHarness(id),
          )}
        >
          <LogIn size={12} />
          {harness.id === "codex" ? "Sign in with ChatGPT" : "Sign in"}
        </Button>
      )}
      {actions.includes("cancel") && (
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={act(harness, "signIn", (id) =>
            window.desktop.cancelHarnessSignIn(id),
          )}
        >
          <X size={12} />
          Cancel sign-in
        </Button>
      )}
      {actions.includes("command") && !compact && (
        <SignInCommand harness={harness} disabled={disabled} />
      )}
      {auth.warning && (
        <p className="harness-line harness-warning" role="note">
          {auth.warning}
        </p>
      )}
      {auth.state === "unknown" && auth.message && (
        <p className="subtle">{auth.message}</p>
      )}
      {notice && (
        <div
          className="harness-notice"
          role="note"
          aria-label={`${harness.label} sign-in notice`}
        >
          <p>{notice}</p>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={act(harness, "notice", (id) =>
              window.desktop.acknowledgeHarnessNotice(id),
            )}
          >
            Got it
          </Button>
        </div>
      )}
    </div>
  );
}

/** A copy-ready terminal command that signs the harness in, then a refresh to pick it up. */
function SignInCommand({
  harness,
  disabled,
}: {
  harness: HarnessState;
  disabled: boolean;
}) {
  // The command last copied; "Copied" reads true only while the shown command is still it.
  const [copied, setCopied] = useState<string | null>(null);
  const command = harness.auth.command ?? "";
  return (
    <div
      className="harness-command"
      role="group"
      aria-label={`${harness.label} sign-in command`}
    >
      <span className="harness-line">
        To use a hosted provider, run this in a terminal, then refresh:
      </span>
      <code>{command}</code>
      <div className="harness-command-actions">
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void navigator.clipboard
              .writeText(command)
              .then(() => setCopied(command))
              .catch(() => setCopied(null))
          }
        >
          <Copy size={12} />
          {copied === command ? "Copied" : "Copy"}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={disabled}
          onClick={act(harness, "refresh", (id) =>
            window.desktop.refreshHarness(id),
          )}
        >
          <RefreshCw size={12} />
          Refresh
        </Button>
      </div>
    </div>
  );
}

/** Ends the app's own login for a harness, confirming first when its tabs are running. */
function SignOut({
  harness,
  disabled,
}: {
  harness: HarnessState;
  disabled: boolean;
}) {
  const rooms = useDesktop().snapshot?.rooms ?? [];
  const running = rooms.some((room) =>
    room.tabs.some(
      (tab) =>
        tab.loadout.harness === harness.id &&
        (tabBusy(tab.status) || Boolean(tab.runningAgents)),
    ),
  );
  const [confirming, setConfirming] = useState(false);
  const signOut = act(harness, "signOut", (id) =>
    window.desktop.signOutHarness(id),
  );
  if (confirming)
    return (
      <div
        className="harness-confirm"
        role="group"
        aria-label={`Sign out of ${harness.label}`}
      >
        <p>
          Sign out of {harness.label}? Its running turns stop and its tabs close
          their sessions.
        </p>
        <div className="harness-command-actions">
          <Button
            size="xs"
            variant="destructive"
            disabled={disabled}
            onClick={() => {
              setConfirming(false);
              signOut();
            }}
          >
            <LogOut size={12} />
            Sign out
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setConfirming(false)}
          >
            Keep signed in
          </Button>
        </div>
      </div>
    );
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={disabled}
      onClick={() => (running ? setConfirming(true) : signOut())}
    >
      <LogOut size={12} />
      Sign out
    </Button>
  );
}

/** A newer published program version, with the way to get it or to go back. */
function UpdateNotice({
  harness,
  disabled,
}: {
  harness: HarnessState;
  disabled: boolean;
}) {
  const update = updateAvailable(harness);
  const later = !harness.program.customPath && harness.laterVersion;
  return (
    <>
      {later && (
        <span className="harness-line harness-update">
          <ArrowUpCircle size={11} aria-hidden="true" />
          {later} available after an app update
        </span>
      )}
      {update && (
        <span className="harness-line harness-update">
          <ArrowUpCircle size={11} aria-hidden="true" />
          {update.version} available
          {update.installable ? (
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              title={`Downloads ${harness.label} ${update.version}, newer than the version this app was tested with.`}
              onClick={act(harness, "update", (id) =>
                window.desktop.updateHarness(id),
              )}
            >
              Update
            </Button>
          ) : (
            harness.program.state === "custom" && " · update your executable"
          )}
        </span>
      )}
      {harness.bundledVersion && !harness.program.customPath && (
        <span className="harness-line harness-update-applied">
          Newer than tested {harness.bundledVersion}
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={act(harness, "update", (id) =>
              window.desktop.revertHarnessUpdate(id),
            )}
          >
            Revert
          </Button>
        </span>
      )}
    </>
  );
}

/** One harness's program, account, usage limits, and the controls to change them. */
export function HarnessConnection({
  harness,
  disabled,
}: {
  harness: HarnessState;
  disabled: boolean;
}) {
  return (
    <div className="harness-row" aria-label={`${harness.label} settings`}>
      <div className="harness-row-heading">
        <strong>{harness.label}</strong>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Refresh ${harness.label}`}
          disabled={disabled}
          onClick={act(harness, "refresh", (id) =>
            window.desktop.refreshHarness(id),
          )}
        >
          <RefreshCw size={12} />
        </Button>
      </div>
      <span className="harness-line">{programLabel(harness)}</span>
      <UpdateNotice harness={harness} disabled={disabled} />
      {harness.program.customPath && (
        <span
          className="harness-line harness-path"
          title={harness.program.customPath}
        >
          {harness.program.customPath}
        </span>
      )}
      <span className="harness-line">{authLabel(harness)}</span>
      {harness.limits.map((limit) => (
        <span className="harness-line" key={limit.name}>
          {Math.round(100 - limit.usedPercent)}% remaining · {limit.name}
        </span>
      ))}
      {harness.localServers && (
        <ul className="harness-servers" aria-label="Local model servers">
          {harness.localServers.map((server) => (
            <li key={server.id}>
              <span className="harness-line">{serverLine(server)}</span>
              {server.note && (
                <span className="harness-line harness-warning">
                  {server.note}
                </span>
              )}
              {server.models
                .filter((model) => model.warning || model.unverified)
                .map((model) => (
                  <span className="harness-line harness-warning" key={model.id}>
                    {model.name}:{" "}
                    {model.warning ??
                      "LM Studio does not say whether it supports tools."}
                  </span>
                ))}
            </li>
          ))}
        </ul>
      )}
      <HarnessStatus harness={harness} disabled={disabled} />
      {accountActions(harness).includes("sign_out") && (
        <SignOut harness={harness} disabled={disabled} />
      )}
      <details className="harness-program">
        <summary>Program</summary>
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={act(harness, "program", (id) =>
            window.desktop.chooseHarnessExecutable(id),
          )}
        >
          <FolderOpen size={12} />
          Choose executable…
        </Button>
        {harness.program.customPath && (
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={act(harness, "program", (id) =>
              window.desktop.useManagedHarness(id),
            )}
          >
            Use managed program
          </Button>
        )}
      </details>
    </div>
  );
}
