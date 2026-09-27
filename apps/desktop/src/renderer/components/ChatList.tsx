import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Room } from "../../shared/contracts";
import type { Tab } from "../../shared/tabs";
import { perform } from "../lib/desktop-store";
import { STATUS_LABELS } from "./tabs/labels";

/** Actions for one closed chat, opened by right-click, Alt+click, or the context-menu key. */
function ChatMenu({
  roomId,
  tab,
  at,
  disabled,
  onClose,
}: {
  roomId: string;
  tab: Tab;
  at: { x: number; y: number };
  disabled: boolean;
  onClose: (refocus: boolean) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  // Deleting is permanent, so the first choice asks again.
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [confirming]);
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onClose(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [onClose]);
  return (
    <div
      ref={root}
      className="chat-menu"
      role="menu"
      aria-label={`${tab.title} actions`}
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
            Delete “{tab.title}” and its transcript from this desktop? This
            cannot be undone.
          </p>
          <button
            type="button"
            role="menuitem"
            className="chat-menu-danger"
            disabled={disabled}
            onClick={() => {
              onClose(false);
              void perform(() =>
                window.desktop.deleteClosedTab(roomId, tab.id),
              );
            }}
          >
            <Trash2 size={13} />
            Delete permanently
          </button>
          <button type="button" role="menuitem" onClick={() => onClose(true)}>
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          role="menuitem"
          className="chat-menu-danger"
          onClick={() => setConfirming(true)}
        >
          <Trash2 size={13} />
          Delete chat…
        </button>
      )}
    </div>
  );
}

/**
 * A room's chats in the sidebar, newest first: open tabs with their status, closed ones
 * hollow. Opening a closed chat reopens its tab with its transcript and session.
 */
export function ChatList({
  room,
  activeTab,
  disabled,
  onOpen,
}: {
  room: Room;
  activeTab: string | null;
  disabled: boolean;
  onOpen: (tab: Tab, closed: boolean) => void;
}) {
  const [menu, setMenu] = useState<{
    tab: Tab;
    at: { x: number; y: number };
    button: HTMLButtonElement;
  } | null>(null);
  const chats = [
    ...room.tabs.map((tab) => ({ tab, closed: false })),
    ...(room.closedTabs ?? []).map((tab) => ({ tab, closed: true })),
  ].sort((a, b) => b.tab.updatedAt.localeCompare(a.tab.updatedAt));
  if (!chats.length) return null;
  function openMenu(tab: Tab, event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    const button = event.currentTarget;
    const rect = button.getBoundingClientRect();
    // The context-menu key reports no pointer position; anchor under the chat instead.
    const keyboard = event.clientX === 0 && event.clientY === 0;
    setMenu({
      tab,
      button,
      at: keyboard
        ? { x: rect.left + 12, y: rect.bottom + 2 }
        : { x: event.clientX, y: event.clientY },
    });
  }
  return (
    <>
      <ul className="chat-list" aria-label={`Chats in ${room.name}`}>
        {chats.map(({ tab, closed }) => (
          <li key={tab.id}>
            <button
              type="button"
              className={closed ? "chat-closed" : undefined}
              aria-current={tab.id === activeTab ? "true" : undefined}
              aria-haspopup={closed ? "menu" : undefined}
              disabled={closed && disabled}
              title={
                closed
                  ? `${tab.title} · closed · open to continue, right-click to delete`
                  : `${tab.title} · ${STATUS_LABELS[tab.status]}`
              }
              onClick={(event) => {
                if (closed && event.altKey) openMenu(tab, event);
                else onOpen(tab, closed);
              }}
              onContextMenu={(event) => {
                if (closed) openMenu(tab, event);
              }}
            >
              <span
                className={`chat-dot ${closed ? "chat-closed" : `status-${tab.status}`}`}
                aria-label={closed ? "Closed" : STATUS_LABELS[tab.status]}
              />
              <span className="chat-title">{tab.title}</span>
            </button>
          </li>
        ))}
      </ul>
      {menu && (
        <ChatMenu
          key={menu.tab.id}
          roomId={room.id}
          tab={menu.tab}
          at={menu.at}
          disabled={disabled}
          onClose={(refocus) => {
            if (refocus) menu.button.focus();
            setMenu(null);
          }}
        />
      )}
    </>
  );
}
