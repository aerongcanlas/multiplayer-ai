import { UserRound, LogOut, RefreshCw, Users } from "lucide-react";
import type { CollaborationState } from "../../shared/collaboration";
import { perform } from "../lib/desktop-store";
import { Button } from "./ui/Button";

export function SharedConnection({
  connection,
  disabled,
}: {
  connection?: CollaborationState;
  disabled: boolean;
}) {
  const signedIn = connection?.auth === "signed_in";
  return (
    <section className="shared-connection" aria-label="Shared room account">
      <div className="shared-account-heading">
        <Users size={15} />
        <strong>{signedIn ? connection.account?.name : "Shared rooms"}</strong>
        {signedIn && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Sign out"
            title="Sign out on this desktop"
            disabled={disabled}
            onClick={() => void perform(() => window.desktop.signOut())}
          >
            <LogOut size={13} />
          </Button>
        )}
      </div>
      {signedIn ? (
        <>
          <div className="shared-sync">
            <span role="status">
              {connection.status === "connected"
                ? "Synced"
                : connection.status === "syncing"
                  ? "Connecting..."
                  : connection.status === "setup_required"
                    ? "Setup required"
                    : "Offline"}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Refresh shared rooms"
              disabled={disabled}
              onClick={() => void perform(() => window.desktop.refreshShared())}
            >
              <RefreshCw size={12} />
            </Button>
          </div>
        </>
      ) : connection?.auth === "signing_in" ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() => void perform(() => window.desktop.cancelSignIn())}
        >
          Cancel sign-in
        </Button>
      ) : (
        <>
          <p>Sign in to use shared rooms and chat with your team.</p>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => void perform(() => window.desktop.signIn())}
          >
            <UserRound size={13} />
            Sign in with GitHub
          </Button>
        </>
      )}
      {connection?.message && (
        <p role="status" className="shared-message">
          {connection.message}
        </p>
      )}
    </section>
  );
}
