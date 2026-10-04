import { LogOut, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Room, Snapshot } from "../../shared/contracts";
import { tabBusy } from "../../shared/tabs";
import { perform } from "../lib/desktop-store";

const without = (snapshot: Snapshot, roomId: string): Snapshot => ({
  ...snapshot,
  rooms: snapshot.rooms.filter((room) => room.id !== roomId),
});

/** Actions for one room, opened by right-click, Alt+click, or the context-menu key. */
export function RoomMenu({
  room,
  at,
  disabled,
  onClose,
}: {
  room: Room;
  at: { x: number; y: number };
  // Shared rooms also need a live connection.
  disabled: boolean;
  onClose: (refocus: boolean) => void;
}) {
  const running = room.tabs.some(
    (tab) => tabBusy(tab.status) || Boolean(tab.runningAgents),
  );
  const root = useRef<HTMLDivElement>(null);
  // Deleting and leaving cannot be undone, so the first choice asks again.
  const [confirming, setConfirming] = useState<"delete" | "leave" | null>(null);
  useEffect(() => {
    // With every action unavailable the menu itself takes focus, so Escape still closes it.
    (
      root.current?.querySelector<HTMLButtonElement>("button:not(:disabled)") ??
      root.current
    )?.focus();
  }, [confirming]);
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onClose(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [onClose]);
  const blocked = disabled || running;
  const reason = running ? "Stop this room's running chats first." : undefined;
  const lastMember = room.shared?.members.length === 1;
  function run(action: "delete" | "leave") {
    onClose(false);
    // The room leaves the list at once while the change is confirmed.
    void perform(
      () =>
        action === "delete"
          ? window.desktop.deleteRoom(room.id)
          : window.desktop.leaveRoom(room.id),
      {
        key: `room.${action}:${room.id}`,
        optimistic: (snapshot) => without(snapshot, room.id),
      },
    );
  }
  return (
    <div
      ref={root}
      className="chat-menu"
      role="menu"
      tabIndex={-1}
      aria-label={`${room.name} actions`}
      style={{ left: at.x, top: at.y }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose(true);
        } else if (event.key === "Tab") onClose(false);
      }}
    >
      {confirming ? (
        <>
          <p className="chat-menu-note">
            {confirming === "delete"
              ? room.shared
                ? `Delete “${room.name}” for every member, with its messages and suggestions?`
                : `Delete “${room.name}” from this desktop?`
              : `Leave “${room.name}”? You need a new invite to rejoin.${
                  lastMember
                    ? " You are its last member, so it is deleted."
                    : ""
                }`}{" "}
            Your chats in it are removed from this desktop. This cannot be
            undone.
          </p>
          <button
            type="button"
            role="menuitem"
            className="chat-menu-danger"
            disabled={blocked}
            title={reason}
            onClick={() => run(confirming)}
          >
            {confirming === "delete" ? (
              <>
                <Trash2 size={13} />
                Delete permanently
              </>
            ) : (
              <>
                <LogOut size={13} />
                Leave room
              </>
            )}
          </button>
          <button type="button" role="menuitem" onClick={() => onClose(true)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          {room.shared && (
            <button
              type="button"
              role="menuitem"
              className="chat-menu-danger"
              disabled={blocked}
              title={reason}
              onClick={() => setConfirming("leave")}
            >
              <LogOut size={13} />
              Leave room…
            </button>
          )}
          {(!room.shared || room.shared.isAdmin) && (
            <button
              type="button"
              role="menuitem"
              className="chat-menu-danger"
              disabled={blocked}
              title={reason}
              onClick={() => setConfirming("delete")}
            >
              <Trash2 size={13} />
              {room.shared ? "Delete room for everyone…" : "Delete room…"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
