import { useState } from "react";
import { UserRound, LogOut, RefreshCw, Users } from "lucide-react";
import type { CollaborationState } from "../../shared/collaboration";
import { perform } from "../lib/desktop-store";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";

export function SharedConnection({
  connection,
  disabled,
  onRoom,
}: {
  connection?: CollaborationState;
  disabled: boolean;
  onRoom: (id: string) => void;
}) {
  const [joining, setJoining] = useState(false);
  const [token, setToken] = useState("");
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
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => setJoining(!joining)}
          >
            Join with invite
          </Button>
          {joining && (
            <form
              className="join-room"
              onSubmit={(event) => {
                event.preventDefault();
                void perform(
                  () => window.desktop.joinRoom(token.trim()),
                  (notice) => {
                    if (notice.kind === "room") {
                      onRoom(notice.roomId);
                      setJoining(false);
                      setToken("");
                    }
                  },
                );
              }}
            >
              <Input
                autoFocus
                aria-label="Invitation code"
                placeholder="Paste invitation code"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                maxLength={43}
              />
              <Button
                size="xs"
                type="submit"
                disabled={disabled || !/^[A-Za-z0-9_-]{43}$/.test(token.trim())}
              >
                Join room
              </Button>
            </form>
          )}
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
          <p>Sign in to create rooms and chat with your team.</p>
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
