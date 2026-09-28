import { useRef, useState, type RefObject } from "react";
import { LogIn, Plus, UserRound } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multiplayer-ai/ui/primitives/dialog";
import { dismissError, perform, useDesktop } from "../lib/desktop-store";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";

export function RoomEntryDialog({
  mode,
  onModeChange,
  onClose,
  onRoom,
  triggerRef,
}: {
  mode: "create" | "join";
  onModeChange: (mode: "create" | "join") => void;
  onClose: () => void;
  onRoom: (id: string) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { snapshot, health, pending, error } = useDesktop();
  const connection = snapshot?.collaboration;
  const signedIn = connection?.auth === "signed_in";
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"local" | "shared">(
    signedIn ? "shared" : "local",
  );
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const shared = mode === "join" || scope === "shared";
  const disabled = pending > 0 || health.status !== "live";
  const valid =
    mode === "create"
      ? Boolean(name.trim())
      : /^[A-Za-z0-9_-]{43}$/.test(token.trim());
  const canSubmit =
    !disabled &&
    !submitting &&
    valid &&
    (!shared || (signedIn && connection.status === "connected"));

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    await perform(
      () =>
        mode === "create"
          ? window.desktop.createRoom(name.trim(), scope)
          : window.desktop.joinRoom(token.trim()),
      (notice) => {
        if (notice.kind === "room") {
          onRoom(notice.roomId);
          onClose();
        }
      },
    );
    setSubmitting(false);
  }

  return (
    <Dialog
      defaultOpen
      onOpenChange={(open, details) => {
        if (!open) {
          if (submitting) details.cancel();
          else onClose();
        }
      }}
    >
      <DialogContent
        className="room-entry-dialog"
        initialFocus={inputRef}
        finalFocus={triggerRef}
        showCloseButton={!submitting}
      >
        <DialogHeader>
          <DialogTitle>Add room</DialogTitle>
          <DialogDescription>
            Create a space or join your team with an invite.
          </DialogDescription>
        </DialogHeader>
        <div className="room-entry-modes" role="group" aria-label="Room action">
          <Button
            variant="ghost"
            aria-pressed={mode === "create"}
            disabled={submitting}
            onClick={() => {
              dismissError();
              onModeChange("create");
            }}
          >
            <Plus size={15} /> Create
          </Button>
          <Button
            variant="ghost"
            aria-pressed={mode === "join"}
            disabled={submitting}
            onClick={() => {
              dismissError();
              onModeChange("join");
            }}
          >
            <LogIn size={15} /> Join with invite
          </Button>
        </div>
        <form
          className="room-entry-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {mode === "create" ? (
            <>
              <label htmlFor="room-entry-name">Room name</label>
              <Input
                ref={inputRef}
                id="room-entry-name"
                placeholder="e.g. Design team"
                maxLength={80}
                value={name}
                disabled={submitting}
                onChange={(event) => setName(event.target.value)}
              />
              <label htmlFor="room-entry-scope">Room visibility</label>
              <select
                id="room-entry-scope"
                value={scope}
                disabled={submitting}
                onChange={(event) =>
                  setScope(event.target.value as "local" | "shared")
                }
                aria-describedby="room-entry-help"
              >
                <option value="local">Local to this desktop</option>
                <option value="shared">Shared with members</option>
              </select>
              <p id="room-entry-help" className="room-entry-hint">
                {scope === "local"
                  ? "Private to this desktop. No sign-in required."
                  : "Share chat and suggestions with invited members."}
              </p>
            </>
          ) : (
            <>
              <label htmlFor="room-entry-token">Invitation code</label>
              <Input
                ref={inputRef}
                id="room-entry-token"
                placeholder="Paste invitation code"
                value={token}
                disabled={submitting}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-describedby="room-entry-help"
              />
              <p id="room-entry-help" className="room-entry-hint">
                Paste the 43-character code from your teammate.
              </p>
            </>
          )}
          {shared && !signedIn && (
            <div className="room-entry-account">
              <p>
                Sign in with GitHub to{" "}
                {mode === "join" ? "join this room" : "create a shared room"}.
              </p>
              {connection?.auth === "signing_in" ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    void perform(() => window.desktop.cancelSignIn())
                  }
                >
                  Cancel sign-in
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void perform(() => window.desktop.signIn())}
                >
                  <UserRound size={15} /> Sign in with GitHub
                </Button>
              )}
            </div>
          )}
          {shared && connection?.message && !error && (
            <p className="room-entry-hint" role="status">
              {connection.message}
            </p>
          )}
          {shared && signedIn && connection.status !== "connected" && (
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => void perform(() => window.desktop.refreshShared())}
            >
              Refresh shared rooms
            </Button>
          )}
          {health.status !== "live" && <p role="status">{health.message}</p>}
          {error && (
            <p className="room-entry-error" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <DialogClose
              render={<Button variant="outline" disabled={submitting} />}
            >
              Cancel
            </DialogClose>
            <Button type="submit" disabled={!canSubmit}>
              {submitting
                ? mode === "create"
                  ? "Creating..."
                  : "Joining..."
                : mode === "create"
                  ? "Create room"
                  : "Join room"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
