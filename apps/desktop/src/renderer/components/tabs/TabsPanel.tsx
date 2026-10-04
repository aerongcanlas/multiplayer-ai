import { ArrowLeft, Bot, CircleStop, Eye, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReadAlongStatus } from "../../../shared/collaboration";
import type { Room, Suggestion } from "../../../shared/contracts";
import {
  HARNESS_IDS,
  HARNESS_LABELS,
  tabBusy,
  type ApprovalDecision,
  type HarnessId,
  type HarnessState,
  type QuestionAnswers,
  type Tab,
  type TranscriptEntry,
} from "../../../shared/tabs";
import {
  perform,
  useDesktop,
  withRoom,
  withTab,
} from "../../lib/desktop-store";
import { programLabel } from "../../lib/harness-status";
import {
  ageLabel,
  SHARED_STATUS_LABELS,
  sharedGroups,
  switchCaption,
} from "../../lib/read-along";
import { useAgents } from "../../lib/transcript-store";
import { plural } from "../../lib/utils";
import { HarnessStatus } from "../HarnessSettings";
import { HarnessPicker } from "./HarnessPicker";
import { PromptInput } from "../PromptInput";
import { Button } from "../ui/Button";
import { LoadoutBar } from "./LoadoutBar";
import { SharedTabView } from "./SharedTabView";
import { TranscriptView, type Actions } from "./TranscriptView";
import { AGENT_STATUS_LABELS, responseKey, STATUS_LABELS } from "./labels";

/** The host's read-along switch for a tab in a shared room, with what it shares. */
function ReadAlongSwitch({
  roomId,
  tab,
  status,
  disabled,
}: {
  roomId: string;
  tab: Tab;
  status: ReadAlongStatus | undefined;
  disabled: boolean;
}) {
  const shares =
    "Room members see your prompts and the agent's messages, masked. Tool output and files stay on this desktop.";
  return (
    <div className="read-along-bar" title={shares}>
      <label className="read-along-switch">
        <input
          type="checkbox"
          role="switch"
          aria-description={shares}
          checked={tab.readAlong}
          disabled={disabled}
          onChange={() => {
            const on = !tab.readAlong;
            void perform(
              () => window.desktop.setReadAlong(roomId, tab.id, on),
              {
                lane: `tab.readAlong:${tab.id}`,
                optimistic: (snapshot) =>
                  withTab(snapshot, roomId, tab.id, (tab) => ({
                    ...tab,
                    readAlong: on,
                  })),
              },
            );
          }}
        />
        <Eye size={12} aria-hidden />
        Read-along
      </label>
      <span className={`read-along-caption state-${status?.state ?? "off"}`}>
        {switchCaption(status, tab.readAlong)}
      </span>
    </div>
  );
}

/** One sub-agent's transcript in the main area, read-only, with a way back to the lead. */
function AgentDrillIn({
  roomId,
  tab,
  agentKey,
  disabled,
  actions,
  onBack,
}: {
  roomId: string;
  tab: Tab;
  agentKey: string;
  disabled: boolean;
  actions: Actions;
  onBack: () => void;
}) {
  const { cards } = useAgents(roomId, tab.id);
  const card = cards.find((item) => item.agent.key === agentKey);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [agentKey]);
  return (
    <>
      <div className="drill-header">
        <Button size="xs" variant="ghost" onClick={onBack}>
          <ArrowLeft size={12} />
          Back to {tab.title}
        </Button>
        <h3 ref={heading} tabIndex={-1}>
          {card?.summary ?? "Sub-agent"}
        </h3>
        {card && (
          <span className={`agent-status status-${card.agent.status}`}>
            {AGENT_STATUS_LABELS[card.agent.status]}
          </span>
        )}
        <span className="subtle">Sub-agent transcript · read-only</span>
      </div>
      <TranscriptView
        key={`${tab.id}:${agentKey}`}
        roomId={roomId}
        tab={tab}
        agentKey={agentKey}
        agent={card}
        disabled={disabled}
        actions={actions}
      />
    </>
  );
}

export function TabsPanel({
  room,
  tab,
  agentKey,
  onSelect,
  onAgentBack,
  harnesses,
  disabled,
  stale,
  draft,
  onDraftChange,
  source,
  onSourceClear,
  onSent,
  sharedTabId,
  onSelectShared,
  onLeaveShared,
  readAlong,
  connected,
  clockOffsetMs,
}: {
  room: Room;
  // The active tab and the sub-agent open in the main area, owned by the room view.
  tab: Tab | undefined;
  agentKey: string | null;
  onSelect: (tabId: string) => void;
  onAgentBack: () => void;
  harnesses: HarnessState[];
  disabled: boolean;
  stale: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  source: Suggestion | null;
  onSourceClear: () => void;
  onSent: (message: string) => void;
  // Another host's read-along tab open in the main area instead of `tab`.
  sharedTabId: string | null;
  onSelectShared: (tabId: string) => void;
  onLeaveShared: () => void;
  readAlong: Record<string, ReadAlongStatus> | undefined;
  connected: boolean;
  clockOffsetMs: number | undefined;
}) {
  const desktop = useDesktop();
  const newTabSetting = desktop.snapshot?.newTabHarness;
  const sharedTabs = room.shared?.sharedTabs ?? [];
  const [closing, setClosing] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const closingTab = room.tabs.find((item) => item.id === closing);
  const harness = harnesses.find((item) => item.id === tab?.loadout.harness);
  const busy = tab ? tabBusy(tab.status) : false;
  // Stop also covers sub-agents still running after the turn.
  const stoppable = busy || Boolean(tab?.runningAgents);
  const stopping = Boolean(tab && desktop.busy.has(`tab.stop:${tab.id}`));
  const models = harness?.models ?? [];
  const modelMissing = Boolean(
    tab &&
    (!tab.loadout.model ||
      (models.length && !models.some((item) => item.id === tab.loadout.model))),
  );

  async function open(id: HarnessId) {
    const known = new Set(room.tabs.map((item) => item.id));
    const snapshot = await perform(() => window.desktop.openTab(room.id, id));
    const created = snapshot?.rooms
      .find((item) => item.id === room.id)
      ?.tabs.find((item) => !known.has(item.id));
    if (created) onSelect(created.id);
  }
  async function close(target: Tab, confirm: boolean) {
    if ((tabBusy(target.status) || target.runningAgents) && !confirm) {
      setClosing(target.id);
      return;
    }
    setClosing(null);
    await perform(() => window.desktop.closeTab(room.id, target.id, confirm), {
      key: `tab.close:${target.id}`,
      optimistic: (snapshot) =>
        withRoom(snapshot, room.id, (room) => ({
          ...room,
          tabs: room.tabs.filter((item) => item.id !== target.id),
        })),
    });
  }
  // Cmd/Ctrl+T opens a tab on the host's new-tab harness; Cmd/Ctrl+W closes the active tab,
  // asking first when it is running.
  const newTabHarness =
    newTabSetting ?? harnesses[0]?.id ?? ("claude" as const);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
        return;
      const key = event.key.toLowerCase();
      if (key !== "t" && key !== "w") return;
      event.preventDefault();
      // Holding the shortcut opens or closes one tab, not one per key repeat.
      if (event.repeat) return;
      // Dialogs own the keyboard while open.
      if (disabled || document.querySelector('[role="dialog"]')) return;
      if (key === "t") void open(newTabHarness);
      else if (tab && !sharedTabId) void close(tab, false);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });
  async function send(text: string) {
    if (!tab) return false;
    const result = await perform(
      () =>
        window.desktop.sendToTab({
          roomId: room.id,
          tabId: tab.id,
          text,
          ...(source
            ? { suggestionId: source.id, suggestionRevision: source.revision }
            : {}),
        }),
      { key: `tab.send:${tab.id}` },
    );
    if (!result) return false;
    onSourceClear();
    onSent(`Sent to ${tab.title}.`);
    return true;
  }
  const actions: Actions = {
    onRespond: (entry: TranscriptEntry, decision: ApprovalDecision) =>
      tab &&
      void perform(
        () =>
          window.desktop.respondToTabApproval(
            room.id,
            tab.id,
            entry.id,
            decision,
          ),
        { key: responseKey(entry.id) },
      ),
    onAnswer: (entry: TranscriptEntry, answers: QuestionAnswers) =>
      tab &&
      void perform(
        () => window.desktop.answerQuestion(room.id, tab.id, entry.id, answers),
        { key: responseKey(entry.id) },
      ),
    onContinuePlan: () =>
      tab &&
      void perform(
        () =>
          window.desktop.sendToTab({
            roomId: room.id,
            tabId: tab.id,
            text: "Implement the plan.",
            continuePlan: true,
          }),
        { key: `tab.send:${tab.id}` },
      ),
    onFreshSession: () =>
      tab &&
      void perform(() => window.desktop.resetTabSession(room.id, tab.id), {
        key: `tab.reset:${tab.id}`,
      }),
  };

  return (
    <section className="panel activity-panel tabs-panel" aria-label="AI tabs">
      <header className="tab-strip">
        <div className="tab-list" role="tablist" aria-label="Chat tabs">
          {room.tabs.map((item) =>
            renaming === item.id ? (
              <form
                key={item.id}
                className="tab-rename"
                onSubmit={(event) => {
                  event.preventDefault();
                  setRenaming(null);
                  const next = title.trim();
                  if (next && next !== item.title)
                    void perform(
                      () => window.desktop.renameTab(room.id, item.id, next),
                      {
                        optimistic: (snapshot) =>
                          withTab(snapshot, room.id, item.id, (tab) => ({
                            ...tab,
                            title: next,
                          })),
                      },
                    );
                }}
              >
                <input
                  autoFocus
                  aria-label="Tab name"
                  maxLength={80}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  onBlur={() => setRenaming(null)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setRenaming(null);
                  }}
                />
              </form>
            ) : (
              <div
                key={item.id}
                className={`tab-chip ${item.id === tab?.id && !sharedTabId ? "tab-active" : ""}`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={item.id === tab?.id && !sharedTabId}
                  title={`${item.title} · ${STATUS_LABELS[item.status]} · double-click to rename`}
                  onClick={() => onSelect(item.id)}
                  onDoubleClick={() => {
                    setTitle(item.title);
                    setRenaming(item.id);
                  }}
                >
                  <span
                    className={`tab-dot status-${item.status}`}
                    aria-label={STATUS_LABELS[item.status]}
                  />
                  <span className="tab-title">{item.title}</span>
                  {Boolean(item.runningAgents) && (
                    <span
                      className="tab-agents"
                      title="Sub-agents still running in this tab"
                    >
                      {item.runningAgents} running
                    </span>
                  )}
                  {Boolean(item.agentRequests) && (
                    <span
                      className="tab-needs"
                      role="img"
                      aria-label="A sub-agent needs you"
                      title="A sub-agent is waiting for you"
                    />
                  )}
                </button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Close ${item.title}`}
                  disabled={disabled}
                  onClick={() => void close(item, false)}
                >
                  <X size={11} />
                </Button>
              </div>
            ),
          )}
          {sharedGroups(sharedTabs).map((group) => (
            <div
              key={group.key}
              className="tab-group"
              role="group"
              aria-label={`Shared by ${group.label}`}
            >
              <span className="tab-group-label">{group.label}</span>
              {group.tabs.map((item) => (
                <div
                  key={item.tabId}
                  className={`tab-chip tab-shared ${item.tabId === sharedTabId ? "tab-active" : ""}`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={item.tabId === sharedTabId}
                    title={`${item.title} · ${SHARED_STATUS_LABELS[item.status]} · ${ageLabel(item.updatedAt, connected, clockOffsetMs)}`}
                    onClick={() => onSelectShared(item.tabId)}
                  >
                    <span
                      className={`tab-dot shared-status-${item.status}`}
                      aria-label={SHARED_STATUS_LABELS[item.status]}
                    />
                    <span className="tab-title">{item.title}</span>
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
        <HarnessPicker
          harnesses={harnesses}
          disabled={disabled}
          onPick={(id) => void open(id)}
        />
        {tab && stoppable && !sharedTabId && (
          <Button
            size="xs"
            variant="outline"
            className="tab-stop"
            disabled={stale || stopping}
            onClick={() =>
              void perform(() => window.desktop.stopTab(room.id, tab.id), {
                key: `tab.stop:${tab.id}`,
              })
            }
          >
            <CircleStop size={13} />
            Stop
          </Button>
        )}
      </header>
      {closingTab && (
        <div
          className="tab-confirm"
          role="alertdialog"
          aria-label="Close running tab"
        >
          <p>
            {tabBusy(closingTab.status)
              ? "This tab is running a turn. Stop it and close the tab?"
              : "This tab has running sub-agents. Stop them and close the tab?"}
          </p>
          <Button size="xs" onClick={() => void close(closingTab, true)}>
            Stop and close
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setClosing(null)}>
            Cancel
          </Button>
        </div>
      )}
      {sharedTabId ? (
        <SharedTabView
          key={sharedTabId}
          roomId={room.id}
          tabId={sharedTabId}
          listed={sharedTabs.find((item) => item.tabId === sharedTabId)}
          harnesses={harnesses}
          connected={connected}
          clockOffsetMs={clockOffsetMs}
          onLeave={onLeaveShared}
        />
      ) : !tab ? (
        <div className="panel-scroll">
          <div className="empty-state">
            <div className="empty-agent-icon">
              <Bot size={22} />
            </div>
            <h3>Open a chat tab</h3>
            <p>
              Each tab runs one coding harness with its own model and session in
              this room&apos;s repository.
            </p>
            <div className="card-actions">
              {HARNESS_IDS.map((id) => (
                <Button
                  key={id}
                  size="xs"
                  disabled={disabled}
                  onClick={() => void open(id)}
                >
                  <Plus size={12} />
                  {HARNESS_LABELS[id]}
                </Button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          {room.shared && !agentKey && (
            <ReadAlongSwitch
              roomId={room.id}
              tab={tab}
              status={readAlong?.[tab.id]}
              disabled={disabled || stale}
            />
          )}
          {harness &&
            (tab.status === "unavailable" || harness.noticePending) && (
              <HarnessStatus harness={harness} disabled={disabled} compact />
            )}
          {harness &&
            tab.status === "unavailable" &&
            harness.program.state === "downloading" && (
              <p className="harness-downloading" role="status">
                {harness.label} · {programLabel(harness)}
              </p>
            )}
          {agentKey ? (
            <AgentDrillIn
              roomId={room.id}
              tab={tab}
              agentKey={agentKey}
              disabled={disabled || stale}
              actions={actions}
              onBack={onAgentBack}
            />
          ) : (
            <TranscriptView
              key={tab.id}
              roomId={room.id}
              tab={tab}
              disabled={disabled || stale}
              actions={actions}
            />
          )}
          <div className="panel-composer" hidden={Boolean(agentKey)}>
            {source && (
              <div className="source-chip">
                <span>
                  {plural(source.sources.length, "source message")} · room
                  suggestion
                </span>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Detach suggestion"
                  onClick={onSourceClear}
                >
                  <X size={12} />
                </Button>
              </div>
            )}
            <div className="composer-lock">
              <PromptInput
                targetKey={tab.id}
                label="Message"
                placeholder={
                  !room.workspace
                    ? "Select a repository to get started…"
                    : busy
                      ? "Draft your next message while the agent works…"
                      : `Message ${tab.title}`
                }
                submitLabel="Send"
                value={draft}
                onChange={onDraftChange}
                busy={disabled || busy}
                disabled={
                  stale ||
                  Boolean(room.shared && !connected) ||
                  !room.workspace ||
                  tab.status === "unavailable" ||
                  tab.status === "resume_failed" ||
                  modelMissing
                }
                onSubmit={send}
                commands={{
                  key: `${room.id}:${tab.loadout.harness}`,
                  load: async () => {
                    const result = await window.desktop.loadCommands(
                      room.id,
                      tab.id,
                    );
                    if (!result.ok) throw new Error(result.error);
                    return result.commands ?? [];
                  },
                }}
                footer={
                  <LoadoutBar
                    loadout={tab.loadout}
                    harness={harness}
                    disabled={disabled || busy}
                    onChange={(loadout) =>
                      void perform(
                        () =>
                          window.desktop.setLoadout(room.id, tab.id, loadout),
                        {
                          lane: `tab.loadout:${tab.id}`,
                          optimistic: (snapshot) =>
                            withTab(snapshot, room.id, tab.id, (tab) => ({
                              ...tab,
                              loadout,
                            })),
                        },
                      )
                    }
                    onSetDefault={(model, effort) =>
                      void perform(
                        () =>
                          window.desktop.setHarnessDefault(
                            tab.loadout.harness,
                            model,
                            effort,
                          ),
                        { key: `harness.default:${tab.loadout.harness}` },
                      )
                    }
                  />
                }
              />
              {!room.workspace && (
                // The prompt stays locked until a repository is chosen; clicking it chooses one.
                <button
                  type="button"
                  className="composer-repo-picker"
                  aria-label="Select a repository to get started"
                  title="Choose a Git repository"
                  disabled={disabled}
                  onClick={() =>
                    void perform(
                      () => window.desktop.selectWorkspace(room.id),
                      {
                        key: `workspace:${room.id}`,
                      },
                    )
                  }
                />
              )}
            </div>
            <p className="composer-hint">
              {HARNESS_LABELS[tab.loadout.harness]} · runs on this desktop with
              your own account
            </p>
          </div>
        </>
      )}
    </section>
  );
}
