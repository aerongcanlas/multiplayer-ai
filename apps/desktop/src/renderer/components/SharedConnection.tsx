import { LogIn, LogOut, RefreshCw, X } from "lucide-react";
import type { CollaborationState } from "../../shared/collaboration";
import { perform } from "../lib/desktop-store";
import { timeLabel } from "../lib/time";
import { Button } from "./ui/Button";

const SYNC_LABELS: Record<CollaborationState["status"], string> = {
  connected: "Up to date",
  syncing: "Connecting…",
  offline: "Offline",
  setup_required: "Setup required",
  disconnected: "Disconnected",
};

const signIn = () =>
  void perform(() => window.desktop.signIn(), { key: "auth.signIn" });
const cancelSignIn = () =>
  void perform(() => window.desktop.cancelSignIn(), { key: "auth.cancel" });

/** The sidebar footer: who is signed in on this desktop, or the way to sign in. */
export function AccountFooter({
  connection,
  disabled,
}: {
  connection?: CollaborationState;
  disabled: boolean;
}) {
  const auth = connection?.auth ?? "signed_out";
  const name =
    auth === "signed_in" ? (connection?.account?.name ?? "Signed in") : null;
  return (
    <>
      <div className="local-avatar" aria-hidden="true">
        {name ? name.slice(0, 1).toUpperCase() : "?"}
      </div>
      <div className="sidebar-account">
        <strong>{name ?? "Not signed in"}</strong>
        <span>
          {auth === "signed_in"
            ? "GitHub · shared rooms"
            : auth === "signing_in"
              ? "Finish in your browser"
              : "Local only"}
        </span>
      </div>
      {auth === "signing_in" ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Cancel sign-in"
          title="Cancel sign-in"
          onClick={cancelSignIn}
        >
          <X size={15} />
        </Button>
      ) : auth === "signed_out" ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Sign in with GitHub"
          title="Sign in with GitHub to use shared rooms"
          disabled={disabled}
          onClick={signIn}
        >
          <LogIn size={15} />
        </Button>
      ) : null}
    </>
  );
}

/** Settings › Account: the GitHub account and the shared-room sync it drives. */
export function AccountSettings({
  connection,
  disabled,
}: {
  connection?: CollaborationState;
  disabled: boolean;
}) {
  const auth = connection?.auth ?? "signed_out";
  return (
    <div className="settings-sections">
      <section className="settings-section" aria-label="GitHub account">
        <h3>GitHub account</h3>
        <div className="settings-rows">
          <div className="settings-field">
            <span className="settings-field-text">
              {auth === "signed_in"
                ? (connection?.account?.name ?? "Signed in")
                : auth === "signing_in"
                  ? "Signing in…"
                  : "Not signed in"}
              <small>
                {auth === "signed_in"
                  ? "Shared rooms, invitations, and team chat use this account. Tabs always run on this desktop."
                  : "Sign in to create or join shared rooms and chat with your team. Local rooms work without an account."}
              </small>
            </span>
            {auth === "signed_in" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                title="Sign out on this desktop"
                onClick={() =>
                  void perform(() => window.desktop.signOut(), {
                    key: "auth.signOut",
                  })
                }
              >
                <LogOut size={13} />
                Sign out
              </Button>
            ) : auth === "signing_in" ? (
              <Button size="sm" variant="outline" onClick={cancelSignIn}>
                Cancel sign-in
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={signIn}
              >
                <LogIn size={13} />
                Sign in with GitHub
              </Button>
            )}
          </div>
        </div>
      </section>
      {auth === "signed_in" && connection && (
        <section className="settings-section" aria-label="Shared rooms">
          <h3>Shared rooms</h3>
          <div className="settings-rows">
            <div className="settings-field">
              <span className="settings-field-text">
                {SYNC_LABELS[connection.status]}
                <small>
                  {connection.message ??
                    (connection.lastSyncedAt
                      ? `Rooms, members, and chat last synced at ${timeLabel(connection.lastSyncedAt)}. They also sync on their own.`
                      : "Rooms, members, and chat sync on their own.")}
                </small>
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() =>
                  void perform(() => window.desktop.refreshShared(), {
                    key: "shared.refresh",
                  })
                }
              >
                <RefreshCw size={13} />
                Sync now
              </Button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
