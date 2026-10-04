import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  Hash,
  Layers3,
  PanelLeft,
  PanelRight,
  Plus,
  Radio,
  Settings,
  X,
  Users,
} from "lucide-react";
import type { CollaborationState } from "../shared/collaboration";
import type { Health, Room, Snapshot, Suggestion } from "../shared/contracts";
import { tabBusy, type HarnessState, type Tab } from "../shared/tabs";
import { dismissError, perform, useDesktop } from "./lib/desktop-store";
import { missionSource } from "./lib/mission";
import { useAgents, useSharedAgents } from "./lib/transcript-store";
import { getStored, setStored } from "./lib/storage";
import { ordered, useReorder, useSavedOrder } from "./lib/reorder";
import { emptyHistory, step, visit, type Location } from "./lib/navigation";
import { Button } from "./components/ui/Button";
import { Input } from "./components/ui/Input";
import { RoomWorkspace } from "@multiplayer-ai/ui/layouts/room-workspace";
import type { ResizablePanelHandle } from "./components/ui/Resizable";
import { GroupChatPanel } from "./components/GroupChatPanel";
import { MissionControlPanel } from "./components/MissionControlPanel";
import { AccountFooter } from "./components/SharedConnection";
import { RoomEntryDialog } from "./components/RoomEntryDialog";
import { RoomMenu } from "./components/RoomMenu";
import { SidebarSection } from "./components/SidebarSection";
import { SettingsDialog } from "./components/SettingsDialog";
import { TabsPanel } from "./components/tabs/TabsPanel";
import { ChatList } from "./components/ChatList";

const roomBusy = (room: Room) => room.tabs.some((tab) => tabBusy(tab.status));
const tabKey = (roomId: string) => `multiplayer:tab:${roomId}`;
const missionKey = "multiplayer:mission-collapsed";
const chatKey = "multiplayer:chat-collapsed";

function RoomView({
  room,
  disabled,
  stale,
  harnesses,
  readAlong,
  collaboration,
  selectedTab,
  onSelectTab,
  sharedTabId,
  onSelectShared,
}: {
  room: Room;
  disabled: boolean;
  stale: boolean;
  harnesses: HarnessState[];
  readAlong: Snapshot["readAlong"];
  collaboration: Snapshot["collaboration"];
  // The active tab and the shared tab open instead, owned by the app so the sidebar can select.
  selectedTab: string | null;
  onSelectTab: (tabId: string) => void;
  sharedTabId: string | null;
  onSelectShared: (tabId: string | null) => void;
}) {
  const [draft, setDraft] = useState("");
  const [source, setSource] = useState<Suggestion | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [invite, setInvite] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{
    tabId: string;
    key: string;
  } | null>(null);
  const missionPanel = useRef<ResizablePanelHandle | null>(null);
  const chatPanel = useRef<ResizablePanelHandle | null>(null);
  const [chatCollapsed, setChatCollapsed] = useState(
    () => getStored(chatKey) === "1",
  );
  const [missionCollapsed, setMissionCollapsed] = useState(
    () => getStored(missionKey) === "1",
  );
  // The stored choice is applied once the panels are laid out, and the panels have the last word.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (getStored(missionKey) === "1") missionPanel.current?.collapse();
      if (getStored(chatKey) === "1") chatPanel.current?.collapse();
      setMissionCollapsed(missionPanel.current?.isCollapsed() ?? false);
      setChatCollapsed(chatPanel.current?.isCollapsed() ?? false);
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const tab = room.tabs.find((item) => item.id === selectedTab) ?? room.tabs[0];
  const harness = harnesses.find((item) => item.id === tab?.loadout.harness);
  const agentKey = viewing && viewing.tabId === tab?.id ? viewing.key : null;
  // Mission Control follows the tab in the main area: a host's shared tab while one is open
  // there, and otherwise the member's own tab.
  const sharedAgents = useSharedAgents(sharedTabId);
  const ownAgents = useAgents(room.id, sharedTabId ? null : (tab?.id ?? null));
  const mission = missionSource({
    tab,
    harness,
    own: ownAgents,
    harnesses,
    watched: sharedTabId
      ? {
          record:
            sharedAgents.record ??
            room.shared?.sharedTabs?.find((item) => item.tabId === sharedTabId),
          agents: sharedAgents,
        }
      : null,
  });
  // Mission Control and the main area both follow the active tab.
  function selectTab(id: string) {
    setViewing(null);
    onSelectTab(id);
  }
  const leaveShared = useCallback(() => onSelectShared(null), [onSelectShared]);
  function leaveAgent() {
    const key = agentKey;
    setViewing(null);
    // Focus returns to the card that opened the drill-in.
    if (key)
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(`[data-agent-card="${CSS.escape(key)}"]`)
          ?.focus(),
      );
  }
  const active = roomBusy(room);
  return (
    <main className="room-view">
      <header className="room-header">
        {room.shared ? (
          <div className="room-members">
            <button
              type="button"
              className="room-scope room-members-trigger"
              popoverTarget={`room-members-${room.id}`}
              aria-label={`Room members, ${room.shared.members.length}`}
            >
              <Users size={13} aria-hidden="true" />
              {room.shared.members.length}{" "}
              {room.shared.members.length === 1 ? "member" : "members"}
              <ChevronDown size={12} aria-hidden="true" />
            </button>
            <div
              id={`room-members-${room.id}`}
              className="room-members-popover"
              popover="auto"
              role="region"
              aria-label="Room members"
            >
              <h2>Room members</h2>
              <ul>
                {room.shared.members.map((member) => (
                  <li key={member.id}>
                    <span>{member.name}</span>
                    {member.id === room.shared?.userId && <small>You</small>}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <span className="room-scope">
            <Hash size={13} />
            Local room
          </span>
        )}
        <h1>{room.name}</h1>
        <div className="room-header-actions">
          {room.shared?.isAdmin && (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void perform(() => window.desktop.createInvite(room.id), {
                  key: `invite:${room.id}`,
                  onNotice: (notice) => {
                    if (notice.kind === "invite") setInvite(notice.token);
                  },
                })
              }
            >
              <Users size={14} />
              Invite
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || active}
            onClick={() =>
              void perform(() => window.desktop.selectWorkspace(room.id), {
                key: `workspace:${room.id}`,
              })
            }
            title={
              room.workspace
                ? `${room.workspace.name} · ${room.workspace.branch}`
                : "Choose a Git repository"
            }
          >
            <FolderGit2 size={14} />
            <span>{room.workspace?.name ?? "Select repository"}</span>
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={chatCollapsed ? "Show Group Chat" : "Hide Group Chat"}
            title={chatCollapsed ? "Show Group Chat" : "Hide Group Chat"}
            aria-pressed={!chatCollapsed}
            onClick={() =>
              chatCollapsed
                ? chatPanel.current?.expand()
                : chatPanel.current?.collapse()
            }
          >
            <PanelRight size={15} />
          </Button>
        </div>
      </header>
      {invite && (
        <div
          className="invite-banner"
          role="region"
          aria-label="Room invitation"
        >
          <div>
            <strong>Single-use invitation · expires in 24 hours</strong>
            <p>
              Share this code with your teammate. They can sign in and choose
              Add room, then Join with invite.
            </p>
          </div>
          <Input
            aria-label="Share invitation code"
            value={invite}
            readOnly
            onFocus={(event) => event.target.select()}
          />
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Close invitation"
            onClick={() => setInvite(null)}
          >
            <X size={14} />
          </Button>
        </div>
      )}
      <div className="room-panels">
        <RoomWorkspace
          mode="window"
          promptResizeLabel="Resize Mission Control"
          promptCollapsedSize="43px"
          promptPanelRef={missionPanel}
          chatCollapsible
          chatPanelRef={chatPanel}
          onChatCollapsedChange={(collapsed) => {
            setChatCollapsed(collapsed);
            setStored(chatKey, collapsed ? "1" : "0");
          }}
          onPromptCollapsedChange={(collapsed) => {
            setMissionCollapsed(collapsed);
            setStored(missionKey, collapsed ? "1" : "0");
          }}
          aiPanel={
            <TabsPanel
              room={room}
              tab={tab}
              agentKey={agentKey}
              onSelect={selectTab}
              onAgentBack={leaveAgent}
              harnesses={harnesses}
              disabled={disabled}
              stale={stale}
              draft={draft}
              onDraftChange={setDraft}
              // A deleted suggestion no longer travels with the draft.
              source={
                source && room.suggestions.some((item) => item.id === source.id)
                  ? source
                  : null
              }
              onSourceClear={() => setSource(null)}
              onSent={setAnnouncement}
              sharedTabId={sharedTabId}
              onSelectShared={(id) => {
                setViewing(null);
                onSelectShared(id);
              }}
              onLeaveShared={leaveShared}
              readAlong={readAlong}
              connected={collaboration?.status === "connected"}
              clockOffsetMs={collaboration?.clockOffsetMs}
            />
          }
          memberChatPanel={
            <GroupChatPanel
              room={room}
              disabled={disabled}
              unavailable={
                stale ||
                Boolean(room.shared && collaboration?.status !== "connected")
              }
            />
          }
          promptPanel={
            <MissionControlPanel
              room={room}
              source={mission}
              agentKey={agentKey}
              collapsed={missionCollapsed}
              onToggle={() =>
                missionCollapsed
                  ? missionPanel.current?.expand()
                  : missionPanel.current?.collapse()
              }
              onSelectAgent={(key) =>
                key && tab ? setViewing({ tabId: tab.id, key }) : leaveAgent()
              }
              disabled={disabled}
              onUseSuggestion={(suggestion) => {
                setDraft(suggestion.prompt);
                setSource(suggestion);
                setViewing(null);
                setAnnouncement(
                  "Prompt added to the active tab's composer. Review it, then send.",
                );
                requestAnimationFrame(() =>
                  document
                    .querySelector<HTMLTextAreaElement>(
                      '[aria-label="Message"]',
                    )
                    ?.focus(),
                );
              }}
            />
          }
        />
      </div>
      <div className="sr-only" role="status">
        {announcement}
      </div>
    </main>
  );
}

const SHARED_PROBLEMS: Partial<Record<CollaborationState["status"], string>> = {
  syncing: "Connecting to shared rooms…",
  offline: "Shared rooms offline",
  setup_required: "Shared rooms need setup",
  disconnected: "Shared rooms disconnected",
};

/** Header status: silent while everything works, a short notice when something does not. */
function ConnectionStatus({
  health,
  connection,
  disabled,
}: {
  health: Health["status"];
  connection?: CollaborationState;
  disabled: boolean;
}) {
  const shared =
    connection?.auth === "signed_in"
      ? SHARED_PROBLEMS[connection.status]
      : undefined;
  return (
    <div className="connection" role="status">
      {health === "connecting" && (
        <span className="connection-notice">
          <span className="status-dot" />
          Starting this desktop…
        </span>
      )}
      {shared && (
        <span
          className="connection-notice"
          title={connection?.message ?? undefined}
        >
          <span className="status-dot stale" />
          {shared}
          {connection?.status !== "syncing" && (
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() =>
                void perform(() => window.desktop.refreshShared(), {
                  key: "shared.refresh",
                })
              }
            >
              Retry
            </Button>
          )}
        </span>
      )}
    </div>
  );
}

export default function App() {
  const { snapshot, health, error } = useDesktop();
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(() =>
    getStored("multiplayer:room"),
  );
  const [sidebarOpen, setSidebarOpen] = useState(
    () => getStored("multiplayer:sidebar") !== "closed",
  );
  const [roomDialog, setRoomDialog] = useState<"create" | "join" | null>(null);
  const [roomMenu, setRoomMenu] = useState<{
    roomId: string;
    at: { x: number; y: number };
    button: HTMLButtonElement;
  } | null>(null);
  function openRoomMenu(
    roomId: string,
    event: React.MouseEvent<HTMLButtonElement>,
  ) {
    event.preventDefault();
    const button = event.currentTarget;
    const rect = button.getBoundingClientRect();
    // The context-menu key reports no pointer position; anchor under the room instead.
    const keyboard = event.clientX === 0 && event.clientY === 0;
    setRoomMenu({
      roomId,
      button,
      at: keyboard
        ? { x: rect.left + 12, y: rect.bottom + 2 }
        : { x: event.clientX, y: event.clientY },
    });
  }
  const addRoomRef = useRef<HTMLButtonElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [roomOrder, setRoomOrder] = useSavedOrder("multiplayer:roomOrder");
  const rooms = ordered(
    snapshot?.rooms ?? [],
    (item) => item.id,
    roomOrder,
    "last",
  );
  const reorderRoom = useReorder(
    "rooms",
    rooms.map((item) => item.id),
    setRoomOrder,
  );
  const settingsRef = useRef<HTMLButtonElement>(null);
  // Each room's active tab, remembered across launches.
  const [selectedTabs, setSelectedTabs] = useState<Record<string, string>>({});
  // Another host's read-along tab open in a room's main area.
  const [shared, setShared] = useState<{
    roomId: string;
    tabId: string;
  } | null>(null);
  const room =
    snapshot?.rooms.find((room) => room.id === selectedRoomId) ??
    snapshot?.rooms[0];
  const disabled = health.status !== "live";
  // The listener below always calls the latest travel, which reads the latest history.
  const travelRef = useRef(travel);
  useEffect(() => {
    travelRef.current = travel;
  });
  function toggleSidebar() {
    setSidebarOpen((current) => {
      setStored("multiplayer:sidebar", current ? "closed" : "open");
      return !current;
    });
  }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (roomDialog || settingsOpen) return;
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleSidebar();
      }
      // Cmd/Ctrl+[ and ], or Alt+Left and Right outside text fields, go back and forward.
      const editing =
        event.target instanceof HTMLElement &&
        event.target.closest("input, textarea, select, [contenteditable]");
      const by =
        (command && event.key === "[") ||
        (event.altKey && event.key === "ArrowLeft" && !editing)
          ? -1
          : (command && event.key === "]") ||
              (event.altKey && event.key === "ArrowRight" && !editing)
            ? 1
            : 0;
      if (by) {
        event.preventDefault();
        travelRef.current(by);
      }
    };
    // The mouse's back and forward buttons.
    const mouse = (event: MouseEvent) => {
      if (
        roomDialog ||
        settingsOpen ||
        (event.button !== 3 && event.button !== 4)
      )
        return;
      event.preventDefault();
      travelRef.current(event.button === 3 ? -1 : 1);
    };
    window.addEventListener("keydown", listener);
    window.addEventListener("mouseup", mouse);
    return () => {
      window.removeEventListener("keydown", listener);
      window.removeEventListener("mouseup", mouse);
    };
  }, [roomDialog, settingsOpen]);
  const selectedTab = (roomId: string) =>
    selectedTabs[roomId] ?? getStored(tabKey(roomId));
  // Back and forward move through the places the main area showed.
  const [history, setHistory] = useState(emptyHistory);
  const here = (): Location | null =>
    room
      ? {
          roomId: room.id,
          tabId: selectedTab(room.id),
          sharedTabId: shared?.roomId === room.id ? shared.tabId : null,
        }
      : null;
  /** Shows a place without recording it. */
  function show({ roomId, tabId, sharedTabId }: Location) {
    setSelectedRoomId(roomId);
    setStored("multiplayer:room", roomId);
    if (tabId) {
      setSelectedTabs((current) => ({ ...current, [roomId]: tabId }));
      setStored(tabKey(roomId), tabId);
    }
    setShared(sharedTabId ? { roomId, tabId: sharedTabId } : null);
  }
  /** Shows a place and records the visit; the place before it is kept as the first entry. */
  function go(location: Location) {
    const current = here();
    setHistory((past) =>
      visit(
        past.entries.length || !current ? past : visit(past, current),
        location,
      ),
    );
    show(location);
  }
  function travel(by: -1 | 1) {
    // A room that is gone is skipped; a closed tab falls back to the room's current tab.
    const moved = step(history, by, ({ roomId }) =>
      Boolean(snapshot?.rooms.some((item) => item.id === roomId)),
    );
    if (!moved) return;
    setHistory(moved.history);
    show(moved.location);
  }
  const canGo = (by: -1 | 1) => {
    const index = history.index + by;
    return index >= 0 && index < history.entries.length;
  };
  function selectRoom(id: string) {
    go({
      roomId: id,
      tabId: selectedTab(id),
      sharedTabId: shared?.roomId === id ? shared.tabId : null,
    });
  }
  function selectTab(roomId: string, tabId: string) {
    go({ roomId, tabId, sharedTabId: null });
  }
  function selectShared(roomId: string, tabId: string | null) {
    go({ roomId, tabId: selectedTab(roomId), sharedTabId: tabId });
  }
  async function openChat(roomId: string, tab: Tab, closed: boolean) {
    if (closed) {
      const result = await perform(
        () => window.desktop.reopenTab(roomId, tab.id),
        { key: `tab.reopen:${tab.id}` },
      );
      if (!result) return;
    }
    selectTab(roomId, tab.id);
  }
  return (
    <div className="desktop-shell" data-health={health.status}>
      <header className="app-bar">
        <nav className="app-nav" aria-label="History">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Back"
            title="Back (Cmd+[)"
            disabled={!canGo(-1)}
            onClick={() => travel(-1)}
          >
            <ArrowLeft size={16} />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Forward"
            title="Forward (Cmd+])"
            disabled={!canGo(1)}
            onClick={() => travel(1)}
          >
            <ArrowRight size={16} />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Toggle sidebar"
            title="Toggle sidebar (Ctrl+B)"
            onClick={toggleSidebar}
          >
            <PanelLeft size={16} />
          </Button>
        </nav>
        <ConnectionStatus
          health={health.status}
          connection={snapshot?.collaboration}
          disabled={disabled}
        />
      </header>
      {error && !roomDialog && !settingsOpen && (
        <div className="error-banner" role="alert">
          <AlertCircle size={16} />
          <p>{error}</p>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss error"
            onClick={dismissError}
          >
            <X size={14} />
          </Button>
        </div>
      )}
      {health.status === "stale" && snapshot && (
        <div className="stale-banner" role="status">
          <AlertCircle size={14} />
          {health.message}
        </div>
      )}
      <div className="app-body">
        <aside
          className={`sidebar ${sidebarOpen ? "" : "sidebar-collapsed"}`}
          aria-label="Rooms sidebar"
        >
          {sidebarOpen ? (
            <>
              <div className="app-brand">
                <Layers3 size={18} />
                <strong>
                  Multiplayer<span>.ai</span>
                </strong>
              </div>
              <div className="sidebar-sections">
                <SidebarSection
                  id="rooms"
                  title="Rooms"
                  count={snapshot?.rooms.length}
                  action={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      ref={addRoomRef}
                      aria-label="Add room"
                      title="Add room"
                      aria-haspopup="dialog"
                      aria-expanded={roomDialog !== null}
                      disabled={disabled}
                      onClick={() => {
                        dismissError();
                        setRoomDialog("create");
                      }}
                    >
                      <Plus size={16} />
                    </Button>
                  }
                >
                  <nav className="room-list" aria-label="Rooms">
                    {rooms.map((item) => (
                      <Fragment key={item.id}>
                        <button
                          type="button"
                          {...reorderRoom(item.id)}
                          aria-current={
                            item.id === room?.id ? "page" : undefined
                          }
                          aria-haspopup="menu"
                          title={`${item.name} · right-click for actions`}
                          onClick={(event) => {
                            if (event.altKey) openRoomMenu(item.id, event);
                            else selectRoom(item.id);
                          }}
                          onContextMenu={(event) =>
                            openRoomMenu(item.id, event)
                          }
                        >
                          {item.shared ? (
                            <Users size={15} />
                          ) : (
                            <Hash size={15} />
                          )}
                          <span>{item.name}</span>
                          {roomBusy(item) && (
                            <span
                              className="room-running"
                              aria-label="Tab running"
                            />
                          )}
                        </button>
                        {item.id === room?.id && (
                          <ChatList
                            room={item}
                            activeTab={
                              shared?.roomId === item.id
                                ? null
                                : (item.tabs.find(
                                    (tab) => tab.id === selectedTab(item.id),
                                  )?.id ??
                                  item.tabs[0]?.id ??
                                  null)
                            }
                            disabled={disabled}
                            onOpen={(tab, closed) =>
                              void openChat(item.id, tab, closed)
                            }
                          />
                        )}
                      </Fragment>
                    ))}
                  </nav>
                </SidebarSection>
              </div>
              <div className="sidebar-footer">
                <AccountFooter
                  connection={snapshot?.collaboration}
                  disabled={disabled}
                />
                <Button
                  ref={settingsRef}
                  size="icon-sm"
                  variant="ghost"
                  className="sidebar-settings"
                  aria-label="Settings"
                  title="Settings"
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings size={15} />
                </Button>
              </div>
            </>
          ) : (
            <button
              className="sidebar-expand"
              aria-label="Expand sidebar"
              onClick={toggleSidebar}
            >
              <ChevronRight size={18} />
            </button>
          )}
          <button
            className="sidebar-rail"
            onClick={toggleSidebar}
            title="Toggle sidebar"
            aria-label="Toggle sidebar rail"
          />
        </aside>
        {room ? (
          <RoomView
            key={`${room.id}:${room.shared?.userId ?? "local"}`}
            room={room}
            disabled={
              disabled ||
              Boolean(
                room.shared && snapshot?.collaboration?.status !== "connected",
              )
            }
            stale={health.status !== "live"}
            harnesses={snapshot?.harnesses ?? []}
            readAlong={snapshot?.readAlong}
            collaboration={snapshot?.collaboration}
            selectedTab={selectedTab(room.id)}
            onSelectTab={(tabId) => selectTab(room.id, tabId)}
            sharedTabId={shared?.roomId === room.id ? shared.tabId : null}
            onSelectShared={(tabId) => selectShared(room.id, tabId)}
          />
        ) : (
          <main className="loading-screen">
            <Radio size={30} />
            <h1>
              {error
                ? "Desktop connection unavailable"
                : "Opening your workspace"}
            </h1>
            <p>{error ?? "Loading the local execution journal..."}</p>
          </main>
        )}
      </div>
      <footer className="status-bar">
        <span>
          <span className={`status-dot ${health.status}`} />
          {room?.workspace
            ? `${room.workspace.branch} · ${room.workspace.revision.slice(0, 8)}${room.workspace.dirty ? " · tracked changes" : ""}`
            : "No repository selected"}
        </span>
        <span>
          {room?.shared
            ? "Chat and suggestions shared · Tabs run on this desktop"
            : "Saved on this desktop · Private local room"}
        </span>
      </footer>
      {settingsOpen && (
        <SettingsDialog
          harnesses={snapshot?.harnesses ?? []}
          disabled={disabled}
          triggerRef={settingsRef}
          onClose={() => {
            setSettingsOpen(false);
            dismissError();
          }}
        />
      )}
      {roomMenu &&
        (() => {
          const target = snapshot?.rooms.find(
            (item) => item.id === roomMenu.roomId,
          );
          return target ? (
            <RoomMenu
              key={target.id}
              room={target}
              at={roomMenu.at}
              disabled={
                disabled ||
                Boolean(
                  target.shared &&
                  snapshot?.collaboration?.status !== "connected",
                )
              }
              onClose={(refocus) => {
                if (refocus) roomMenu.button.focus();
                setRoomMenu(null);
              }}
            />
          ) : null;
        })()}
      {roomDialog && (
        <RoomEntryDialog
          mode={roomDialog}
          onModeChange={setRoomDialog}
          onRoom={selectRoom}
          triggerRef={addRoomRef}
          onClose={() => {
            setRoomDialog(null);
            dismissError();
          }}
        />
      )}
    </div>
  );
}
