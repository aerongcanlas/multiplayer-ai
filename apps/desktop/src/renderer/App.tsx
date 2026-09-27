import { useCallback, useEffect, useState } from "react";
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
import { tabBusy, type HarnessState } from "../shared/tabs";
import { dismissError, perform, useDesktop } from "./lib/desktop-store";
import { getStored, setStored } from "./lib/storage";
import { Button } from "./components/ui/Button";
import { Input } from "./components/ui/Input";
import { RoomWorkspace } from "@multiplayer-ai/ui/layouts/room-workspace";
import { GroupChatPanel } from "./components/GroupChatPanel";
import { MissionControlPanel } from "./components/MissionControlPanel";
import { SharedConnection } from "./components/SharedConnection";
import { SidebarSection } from "./components/SidebarSection";
import { HarnessSettings } from "./components/HarnessSettings";
import { TabsPanel } from "./components/tabs/TabsPanel";

const roomBusy = (room: Room) => room.tabs.some((tab) => tabBusy(tab.status));
const tabKey = (roomId: string) => `multiplayer:tab:${roomId}`;

function RoomView({
  room,
  disabled,
  stale,
  harnesses,
  readAlong,
  collaboration,
}: {
  room: Room;
  disabled: boolean;
  stale: boolean;
  harnesses: HarnessState[];
  readAlong: Snapshot["readAlong"];
  collaboration: Snapshot["collaboration"];
}) {
  const [draft, setDraft] = useState("");
  const [source, setSource] = useState<Suggestion | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [invite, setInvite] = useState<string | null>(null);
  // Mission Control and the main area both follow the active tab.
  const [selectedTab, setSelectedTab] = useState<string | null>(() =>
    getStored(tabKey(room.id)),
  );
  // Another host's read-along tab open in the main area.
  const [sharedTabId, setSharedTabId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{
    tabId: string;
    key: string;
  } | null>(null);
  const tab = room.tabs.find((item) => item.id === selectedTab) ?? room.tabs[0];
  const harness = harnesses.find((item) => item.id === tab?.loadout.harness);
  const agentKey = viewing && viewing.tabId === tab?.id ? viewing.key : null;
  function selectTab(id: string) {
    setSharedTabId(null);
    setSelectedTab(id);
    setViewing(null);
    setStored(tabKey(room.id), id);
  }
  const leaveShared = useCallback(() => setSharedTabId(null), []);
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
              Join with invite.
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
                setSharedTabId(id);
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
  const [creating, setCreating] = useState(false);
  const [roomName, setRoomName] = useState("");
  const [roomScope, setRoomScope] = useState<"local" | "shared">("local");
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  function selectRoom(id: string) {
    setSelectedRoomId(id);
    setStored("multiplayer:room", id);
  }
  async function createRoom() {
    const result = await perform(
      () => window.desktop.createRoom(roomName, roomScope),
      (notice) => {
        if (notice.kind === "room") selectRoom(notice.roomId);
      },
    );
    if (result) {
      setRoomName("");
      setCreating(false);
    }
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
      {error && (
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
                      aria-label="New room"
                      title="New room"
                      aria-expanded={creating}
                      disabled={disabled}
                      onClick={() => {
                        setCreating(!creating);
                        setRoomScope(
                          snapshot?.collaboration?.auth === "signed_in"
                            ? "shared"
                            : "local",
                        );
                      }}
                    >
                      <Plus size={16} />
                    </Button>
                  }
                >
                  {creating && (
                    <form
                      className="create-room"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void createRoom();
                      }}
                    >
                      <Input
                        autoFocus
                        aria-label="Room name"
                        maxLength={80}
                        placeholder="Room name"
                        value={roomName}
                        onChange={(event) => setRoomName(event.target.value)}
                      />
                      <select
                        aria-label="Room visibility"
                        value={roomScope}
                        onChange={(event) =>
                          setRoomScope(event.target.value as "local" | "shared")
                        }
                      >
                        <option value="local">Local to this desktop</option>
                        <option
                          value="shared"
                          disabled={
                            snapshot?.collaboration?.auth !== "signed_in"
                          }
                        >
                          Shared with members
                        </option>
                      </select>
                      <div>
                        <Button
                          size="xs"
                          type="submit"
                          disabled={disabled || !roomName.trim()}
                        >
                          Create room
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => setCreating(false)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </form>
                  )}
                  <nav className="room-list" aria-label="Rooms">
                    {snapshot?.rooms.map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        aria-current={item.id === room?.id ? "page" : undefined}
                        onClick={() => selectRoom(item.id)}
                      >
                        {item.shared ? <Users size={15} /> : <Hash size={15} />}
                        <span>{item.name}</span>
                        {roomBusy(item) && (
                          <span
                            className="room-running"
                            aria-label="Tab running"
                          />
                        )}
                      </button>
                    ))}
                  </nav>
                </SidebarSection>
                <SidebarSection id="account" title="Account">
                  <SharedConnection
                    connection={snapshot?.collaboration}
                    disabled={disabled}
                    onRoom={selectRoom}
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
    </div>
  );
}
