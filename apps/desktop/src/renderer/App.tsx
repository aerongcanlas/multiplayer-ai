import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ChevronRight,
  FolderGit2,
  Hash,
  Layers3,
  PanelLeft,
  Plus,
  Radio,
  X,
  Users,
} from "lucide-react";
import type { Room, Snapshot, Suggestion } from "../shared/contracts";
import { tabBusy, type HarnessState, type Tab } from "../shared/tabs";
import { dismissError, perform, useDesktop } from "./lib/desktop-store";
import { getStored, setStored } from "./lib/storage";
import { Button } from "./components/ui/Button";
import { Input } from "./components/ui/Input";
import { RoomWorkspace } from "@multiplayer-ai/ui/layouts/room-workspace";
import { GroupChatPanel } from "./components/GroupChatPanel";
import { MissionControlPanel } from "./components/MissionControlPanel";
import { SharedConnection } from "./components/SharedConnection";
import { RoomEntryDialog } from "./components/RoomEntryDialog";
import { SidebarSection } from "./components/SidebarSection";
import { HarnessSettings } from "./components/HarnessSettings";
import { TabsPanel } from "./components/tabs/TabsPanel";
import { ChatList } from "./components/ChatList";

const roomBusy = (room: Room) => room.tabs.some((tab) => tabBusy(tab.status));
const tabKey = (roomId: string) => `multiplayer:tab:${roomId}`;

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
  const tab = room.tabs.find((item) => item.id === selectedTab) ?? room.tabs[0];
  const harness = harnesses.find((item) => item.id === tab?.loadout.harness);
  const agentKey = viewing && viewing.tabId === tab?.id ? viewing.key : null;
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
        <span className="room-scope">
          <Hash size={13} />
          {room.shared ? `${room.shared.members.length} members` : "Local room"}
        </span>
        <h1>{room.name}</h1>
        <div className="room-header-actions">
          {room.shared?.isAdmin && (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void perform(
                  () => window.desktop.createInvite(room.id),
                  (notice) => {
                    if (notice.kind === "invite") setInvite(notice.token);
                  },
                )
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
              void perform(() => window.desktop.selectWorkspace(room.id))
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
              source={source}
              onSourceClear={() => setSource(null)}
              onSent={(message) => {
                setDraft("");
                setAnnouncement(message);
              }}
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
          memberChatPanel={<GroupChatPanel room={room} disabled={disabled} />}
          promptPanel={
            <MissionControlPanel
              room={room}
              tab={tab}
              harness={harness}
              agentKey={agentKey}
              onSelectAgent={(key) =>
                key && tab ? setViewing({ tabId: tab.id, key }) : leaveAgent()
              }
              disabled={disabled}
              watching={
                room.shared?.sharedTabs?.find(
                  (item) => item.tabId === sharedTabId,
                )?.title
              }
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

export default function App() {
  const { snapshot, health, pending, error } = useDesktop();
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(() =>
    getStored("multiplayer:room"),
  );
  const [sidebarOpen, setSidebarOpen] = useState(
    () => getStored("multiplayer:sidebar") !== "closed",
  );
  const [roomDialog, setRoomDialog] = useState<"create" | "join" | null>(null);
  const addRoomRef = useRef<HTMLButtonElement>(null);
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
  const disabled = pending > 0 || health.status !== "live";
  function toggleSidebar() {
    setSidebarOpen((current) => {
      setStored("multiplayer:sidebar", current ? "closed" : "open");
      return !current;
    });
  }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (roomDialog) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [roomDialog]);
  function selectRoom(id: string) {
    setSelectedRoomId(id);
    setStored("multiplayer:room", id);
  }
  const selectedTab = (roomId: string) =>
    selectedTabs[roomId] ?? getStored(tabKey(roomId));
  function selectTab(roomId: string, tabId: string) {
    setSelectedTabs((current) => ({ ...current, [roomId]: tabId }));
    setStored(tabKey(roomId), tabId);
    setShared(null);
  }
  const selectShared = useCallback(
    (roomId: string, tabId: string | null) =>
      setShared(tabId ? { roomId, tabId } : null),
    [],
  );
  async function openChat(roomId: string, tab: Tab, closed: boolean) {
    selectRoom(roomId);
    if (closed) {
      const result = await perform(() =>
        window.desktop.reopenTab(roomId, tab.id),
      );
      if (!result) return;
    }
    selectTab(roomId, tab.id);
  }
  return (
    <div className="desktop-shell">
      <header className="app-bar">
        <div className="app-brand">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Toggle sidebar"
            title="Toggle sidebar (Ctrl+B)"
            onClick={toggleSidebar}
          >
            <PanelLeft size={17} />
          </Button>
          <Layers3 size={20} />
          <strong>
            Multiplayer<span>.ai</span>
          </strong>
          <span className="desktop-label">Desktop</span>
        </div>
        <div className={`connection connection-${health.status}`} role="status">
          <span />
          {health.status === "live"
            ? "Local supervisor connected"
            : health.status === "stale"
              ? "Progress is stale"
              : "Connecting"}
          <span className="local-label">
            {snapshot?.collaboration?.status === "connected"
              ? "Shared rooms connected"
              : "Local execution"}
          </span>
        </div>
      </header>
      {error && !roomDialog && (
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
        <div className="stale-banner">
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
                    {snapshot?.rooms.map((item) => (
                      <Fragment key={item.id}>
                        <button
                          type="button"
                          aria-current={
                            item.id === room?.id ? "page" : undefined
                          }
                          onClick={() => selectRoom(item.id)}
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
                <SidebarSection id="account" title="Account">
                  <SharedConnection
                    connection={snapshot?.collaboration}
                    disabled={disabled}
                  />
                </SidebarSection>
                <SidebarSection
                  id="harnesses"
                  title="Harnesses"
                  count={snapshot?.harnesses?.length}
                >
                  <HarnessSettings
                    harnesses={snapshot?.harnesses ?? []}
                    disabled={disabled}
                  />
                </SidebarSection>
              </div>
              <div className="sidebar-footer">
                <div className="local-avatar">Y</div>
                <div>
                  <strong>Your desktop</strong>
                  <span>Private local workspace</span>
                </div>
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
