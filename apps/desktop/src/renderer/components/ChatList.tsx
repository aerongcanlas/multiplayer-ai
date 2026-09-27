import type { Room } from "../../shared/contracts";
import type { Tab } from "../../shared/tabs";
import { STATUS_LABELS } from "./tabs/labels";

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
  const chats = [
    ...room.tabs.map((tab) => ({ tab, closed: false })),
    ...(room.closedTabs ?? []).map((tab) => ({ tab, closed: true })),
  ].sort((a, b) => b.tab.updatedAt.localeCompare(a.tab.updatedAt));
  if (!chats.length) return null;
  return (
    <ul className="chat-list" aria-label={`Chats in ${room.name}`}>
      {chats.map(({ tab, closed }) => (
        <li key={tab.id}>
          <button
            type="button"
            className={closed ? "chat-closed" : undefined}
            aria-current={tab.id === activeTab ? "true" : undefined}
            disabled={closed && disabled}
            title={
              closed
                ? `${tab.title} · closed · open to continue`
                : `${tab.title} · ${STATUS_LABELS[tab.status]}`
            }
            onClick={() => onOpen(tab, closed)}
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
  );
}
