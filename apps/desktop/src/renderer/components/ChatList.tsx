import { Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Room } from "../../shared/contracts";
import { tabBusy, type Tab } from "../../shared/tabs";
import { perform } from "../lib/desktop-store";
import { STATUS_LABELS } from "./tabs/labels";

/** Actions for one chat, opened by right-click, Alt+click, or the context-menu key. */
function ChatMenu({
  roomId,
  tab,
  closed,
  at,
  disabled,
  onClose,
}: {
  roomId: string;
  tab: Tab;
  closed: boolean;
  at: { x: number; y: number };
  disabled: boolean;
  onClose: (refocus: boolean) => void;
}) {
  const running =
    !closed && (tabBusy(tab.status) || Boolean(tab.runningAgents));
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
            Delete “{tab.title}” and its transcript from this desktop?
            {running && " It is running and will be stopped."} This cannot be
            undone.
          </p>
          <button
            type="button"
            role="menuitem"
            className="chat-menu-danger"
            disabled={disabled}
            onClick={() => {
              onClose(false);
              void (async () => {
                // An open chat closes first, stopping its turn if one runs.
                if (
                  !closed &&
                  !(await perform(() =>
                    window.desktop.closeTab(roomId, tab.id, running),
                  ))
                )
                  return;
                await perform(() =>
                  window.desktop.deleteClosedTab(roomId, tab.id),
                );
              })();
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
        <>
          {!closed && (
            <button
              type="button"
              role="menuitem"
              disabled={disabled || running}
              title={
                running ? "Stop the chat or close its tab first." : undefined
              }
              onClick={() => {
                onClose(false);
                void perform(() => window.desktop.closeTab(roomId, tab.id));
              }}
            >
              <X size={13} />
              Close chat
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="chat-menu-danger"
            onClick={() => setConfirming(true)}
          >
            <Trash2 size={13} />
            Delete chat…
          </button>
        </>
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
    closed: boolean;
    at: { x: number; y: number };
    button: HTMLButtonElement;
  } | null>(null);
  const chats = [
    ...room.tabs.map((tab) => ({ tab, closed: false })),
    ...(room.closedTabs ?? []).map((tab) => ({ tab, closed: true })),
    // Newest first, by when a chat opened or closed, so status updates never reorder rows.
  ].sort((a, b) =>
    (b.tab.closedAt ?? b.tab.createdAt).localeCompare(
      a.tab.closedAt ?? a.tab.createdAt,
    ),
  );
  if (!chats.length) return null;
  function openMenu(
    tab: Tab,
    closed: boolean,
    event: React.MouseEvent<HTMLButtonElement>,
  ) {
    event.preventDefault();
    const button = event.currentTarget;
    const rect = button.getBoundingClientRect();
    // The context-menu key reports no pointer position; anchor under the chat instead.
    const keyboard = event.clientX === 0 && event.clientY === 0;
    setMenu({
      tab,
      closed,
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
              aria-haspopup="menu"
              disabled={closed && disabled}
              title={
                closed
                  ? `${tab.title} · closed · open to continue, right-click for actions`
                  : `${tab.title} · ${STATUS_LABELS[tab.status]} · right-click for actions`
              }
              onClick={(event) => {
                if (event.altKey) openMenu(tab, closed, event);
                else onOpen(tab, closed);
              }}
              onContextMenu={(event) => openMenu(tab, closed, event)}
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
          closed={menu.closed}
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
