import { useEffect, useState } from "react";
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
import type { Room, Suggestion } from "../shared/contracts";
import { currentExecution } from "../shared/selectors";
import { dismissError, perform, useDesktop } from "./lib/desktop-store";
import { Button } from "./components/ui/Button";
import { Input } from "./components/ui/Input";
import { RoomWorkspace } from "@multiplayer-ai/ui/layouts/room-workspace";
import { AIActivityPanel } from "./components/AIActivityPanel";
import { GroupChatPanel } from "./components/GroupChatPanel";
import { MissionControlPanel } from "./components/MissionControlPanel";
import { SharedConnection } from "./components/SharedConnection";
import { ProviderConnection } from "./components/ProviderConnection";
import { RunControls } from "./components/RunControls";
import type { ProviderState, RunConfiguration } from "../shared/provider";

function RoomView({
  room,
  disabled,
  active,
  stale,
  provider,
}: {
  room: Room;
  disabled: boolean;
  active: boolean;
  stale: boolean;
  provider?: ProviderState;
}) {
  const [draft, setDraft] = useState("");
  const [source, setSource] = useState<Suggestion | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [scenario, setScenario] = useState<"success" | "validation-failure">(
    "success",
  );
  const [announcement, setAnnouncement] = useState("");
  const [invite, setInvite] = useState<string | null>(null);
  const [runnerChoice, setRunnerChoice] = useState<"mock" | "codex" | null>(
    null,
  );
  const runner =
    runnerChoice ?? (provider?.status === "connected" ? "codex" : "mock");
  const [options, setOptions] = useState<RunConfiguration>({
    model: "",
    effort: "medium",
    mode: "read-only",
    concurrency: 2,
  });
  const selectedModel =
    provider?.models.find((item) => item.id === options.model) ??
    provider?.models.find((item) => item.isDefault) ??
    provider?.models[0];
  const configuration: RunConfiguration = {
    ...options,
    model: selectedModel?.id ?? "",
    effort: selectedModel?.efforts.includes(options.effort)
      ? options.effort
      : ((selectedModel?.defaultEffort ??
          "medium") as RunConfiguration["effort"]),
  };
  const execution =
    room.executions.find((run) => run.id === selectedRunId) ??
    currentExecution(room);
  async function run(prompt: string) {
    const result = await perform(() =>
      window.desktop.startExecution({
        roomId: room.id,
        prompt,
        scenario,
        runner,
        ...(runner === "codex" ? { configuration } : {}),
        ...(source
          ? { suggestionId: source.id, suggestionRevision: source.revision }
          : {}),
      }),
    );
    if (!result) return false;
    setSource(null);
    setSelectedRunId(null);
    setTaskId(null);
    setAnnouncement(
      runner === "codex" ? "Codex execution started." : "Simulation started.",
    );
    return true;
  }
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
            <AIActivityPanel
              room={room}
              execution={execution}
              taskId={taskId}
              onTaskSelect={setTaskId}
              onExecutionSelect={(id) => {
                setSelectedRunId(id);
                setTaskId(null);
              }}
              draft={draft}
              onDraftChange={setDraft}
              source={source}
              onSourceClear={() => setSource(null)}
              scenario={scenario}
              onScenarioChange={setScenario}
              onSubmit={run}
              disabled={disabled}
              active={active}
              stale={stale}
              runner={runner}
              ready={
                runner === "mock" ||
                (provider?.status === "connected" && Boolean(selectedModel))
              }
              controls={
                <RunControls
                  runner={runner}
                  onRunner={setRunnerChoice}
                  provider={provider}
                  configuration={configuration}
                  onConfiguration={setOptions}
                  disabled={active || disabled}
                />
              }
            />
          }
          memberChatPanel={<GroupChatPanel room={room} disabled={disabled} />}
          promptPanel={
            <MissionControlPanel
              room={room}
              execution={execution}
              selectedTaskId={taskId}
              onTaskSelect={setTaskId}
              disabled={disabled}
              stale={stale}
              onUseSuggestion={(suggestion) => {
                setDraft(suggestion.prompt);
                setSource(suggestion);
                setAnnouncement(
                  "Prompt added to the composer. Review it, then start the run.",
                );
                document
                  .querySelector<HTMLTextAreaElement>(
                    '[aria-label="Agent direction"]',
                  )
                  ?.focus();
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
    localStorage.getItem("multiplayer:room"),
  );
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem("multiplayer:sidebar") !== "closed",
  );
  const [creating, setCreating] = useState(false);
  const [roomName, setRoomName] = useState("");
  const [roomScope, setRoomScope] = useState<"local" | "shared">("local");
  const room =
    snapshot?.rooms.find((room) => room.id === selectedRoomId) ??
    snapshot?.rooms[0];
  const active = Boolean(
    snapshot?.rooms.some((room) =>
      room.executions.some((run) => run.status === "running"),
    ),
  );
  const disabled = pending > 0 || health.status !== "live";
  function toggleSidebar() {
    setSidebarOpen((current) => {
      localStorage.setItem("multiplayer:sidebar", current ? "closed" : "open");
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
    localStorage.setItem("multiplayer:room", id);
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
              <div className="sidebar-heading">
                <span>ROOMS</span>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="New room"
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
              </div>
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
                      disabled={snapshot?.collaboration?.auth !== "signed_in"}
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
                    {item.executions.some(
                      (run) => run.status === "running",
                    ) && (
                      <span
                        className="room-running"
                        aria-label="Execution running"
                      />
                    )}
                  </button>
                ))}
              </nav>
              <SharedConnection
                connection={snapshot?.collaboration}
                disabled={disabled}
                onRoom={selectRoom}
              />
              <ProviderConnection
                provider={snapshot?.provider}
                disabled={disabled}
                active={active}
              />
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
            active={active}
            stale={health.status !== "live"}
            provider={snapshot?.provider}
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
            ? "Chat and suggestions shared · Runs stay on this desktop"
            : "Saved on this desktop · Private local room"}
        </span>
      </footer>
    </div>
  );
}
