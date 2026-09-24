import { Bot, CircleStop, Plus, X } from "lucide-react";
import { useState } from "react";
import type { Room, Suggestion } from "../../../shared/contracts";
import {
  HARNESS_IDS,
  HARNESS_LABELS,
  tabBusy,
  type HarnessId,
  type HarnessState,
  type Tab,
  type TranscriptEntry,
} from "../../../shared/tabs";
import { perform } from "../../lib/desktop-store";
import { HarnessStatus } from "../HarnessSettings";
import { PromptInput } from "../PromptInput";
import { Button } from "../ui/Button";
import { LoadoutBar } from "./LoadoutBar";
import { TranscriptView } from "./TranscriptView";

const STATUS_LABELS: Record<Tab["status"], string> = {
  unavailable: "Needs setup",
  idle: "Ready",
  running: "Running",
  awaiting_host: "Waiting for you",
  error: "Error",
  interrupted: "Interrupted",
  resume_failed: "Session lost",
};
const storageKey = (roomId: string) => `multiplayer:tab:${roomId}`;
const remembered = (roomId: string) => {
  try {
    return localStorage.getItem(storageKey(roomId));
  } catch {
    return null;
  }
};

export function TabsPanel({
  room,
  harnesses,
  disabled,
  stale,
  draft,
  onDraftChange,
  source,
  onSourceClear,
  onSent,
}: {
  room: Room;
  harnesses: HarnessState[];
  disabled: boolean;
  stale: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  source: Suggestion | null;
  onSourceClear: () => void;
  onSent: (message: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(() =>
    remembered(room.id),
  );
  const [picking, setPicking] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const tab = room.tabs.find((item) => item.id === selected) ?? room.tabs[0];
  const harness = harnesses.find((item) => item.id === tab?.loadout.harness);
  const busy = tab ? tabBusy(tab.status) : false;
  const models = harness?.models ?? [];
  const modelMissing = Boolean(
    tab &&
    (!tab.loadout.model ||
      (models.length && !models.some((item) => item.id === tab.loadout.model))),
  );

  function select(id: string) {
    setSelected(id);
    try {
      localStorage.setItem(storageKey(room.id), id);
    } catch {
      /* The selection is a convenience only. */
    }
  }
  async function open(id: HarnessId) {
    setPicking(false);
    const known = new Set(room.tabs.map((item) => item.id));
    const snapshot = await perform(() => window.desktop.openTab(room.id, id));
    const created = snapshot?.rooms
      .find((item) => item.id === room.id)
      ?.tabs.find((item) => !known.has(item.id));
    if (created) select(created.id);
  }
  async function close(target: Tab, confirm: boolean) {
    if (tabBusy(target.status) && !confirm) {
      setClosing(target.id);
      return;
    }
    setClosing(null);
    await perform(() => window.desktop.closeTab(room.id, target.id, confirm));
  }
  async function send(text: string) {
    if (!tab) return false;
    const result = await perform(() =>
      window.desktop.sendToTab({
        roomId: room.id,
        tabId: tab.id,
        text,
        ...(source
          ? { suggestionId: source.id, suggestionRevision: source.revision }
          : {}),
      }),
    );
    if (!result) return false;
    onSourceClear();
    onSent(`Sent to ${tab.title}.`);
    return true;
  }
  const actions = {
    onRespond: (entry: TranscriptEntry, decision: "accept" | "decline") =>
      tab &&
      void perform(() =>
        window.desktop.respondToTabApproval(
          room.id,
          tab.id,
          entry.id,
          decision,
        ),
      ),
    onAnswer: (entry: TranscriptEntry, answers: Record<string, string[]>) =>
      tab &&
      void perform(() =>
        window.desktop.answerQuestion(room.id, tab.id, entry.id, answers),
      ),
    onContinuePlan: () =>
      tab &&
      void perform(() =>
        window.desktop.sendToTab({
          roomId: room.id,
          tabId: tab.id,
          text: "Implement the plan.",
          continuePlan: true,
        }),
      ),
    onFreshSession: () =>
      tab &&
      void perform(() => window.desktop.resetTabSession(room.id, tab.id)),
  };

  return (
    <section className="panel activity-panel tabs-panel" aria-label="AI tabs">
      <header className="tab-strip" role="tablist" aria-label="Chat tabs">
        {room.tabs.map((item) =>
          renaming === item.id ? (
            <form
              key={item.id}
              className="tab-rename"
              onSubmit={(event) => {
                event.preventDefault();
                setRenaming(null);
                if (title.trim() && title.trim() !== item.title)
                  void perform(() =>
                    window.desktop.renameTab(room.id, item.id, title.trim()),
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
              className={`tab-chip ${item.id === tab?.id ? "tab-active" : ""}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={item.id === tab?.id}
                title={`${item.title} · ${STATUS_LABELS[item.status]} · double-click to rename`}
                onClick={() => select(item.id)}
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
        <div className="tab-new">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="New tab"
            aria-expanded={picking}
            disabled={disabled}
            onClick={() => setPicking(!picking)}
          >
            <Plus size={14} />
          </Button>
          {picking && (
            <div
              className="tab-picker"
              role="menu"
              aria-label="Choose a harness"
            >
              {HARNESS_IDS.map((id) => (
                <button
                  type="button"
                  role="menuitem"
                  key={id}
                  onClick={() => void open(id)}
                >
                  {HARNESS_LABELS[id]}
                </button>
              ))}
            </div>
          )}
        </div>
        {tab && busy && (
          <Button
            size="xs"
            variant="outline"
            className="tab-stop"
            disabled={stale}
            onClick={() =>
              void perform(() => window.desktop.stopTab(room.id, tab.id))
            }
          >
            <CircleStop size={13} />
            Stop
          </Button>
        )}
      </header>
      {closing && (
        <div
          className="tab-confirm"
          role="alertdialog"
          aria-label="Close running tab"
        >
          <p>This tab is running a turn. Stop it and close the tab?</p>
          <Button
            size="xs"
            onClick={() => {
              const target = room.tabs.find((item) => item.id === closing);
              if (target) void close(target, true);
            }}
          >
            Stop and close
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setClosing(null)}>
            Cancel
          </Button>
        </div>
      )}
      {!tab ? (
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
          {harness &&
            (tab.status === "unavailable" || harness.noticePending) && (
              <HarnessStatus harness={harness} disabled={disabled} compact />
            )}
          {harness &&
            tab.status === "unavailable" &&
            harness.program.state === "downloading" && (
              <p className="harness-downloading" role="status">
                Downloading {harness.label} {harness.program.pinned}…{" "}
                {Math.round((harness.program.progress ?? 0) * 100)}%
              </p>
            )}
          <TranscriptView
            key={tab.id}
            roomId={room.id}
            tab={tab}
            disabled={disabled || stale}
            actions={actions}
          />
          <div className="panel-composer">
            <LoadoutBar
              loadout={tab.loadout}
              harness={harness}
              disabled={disabled || busy}
              onChange={(loadout) =>
                void perform(() =>
                  window.desktop.setLoadout(room.id, tab.id, loadout),
                )
              }
            />
            {source && (
              <div className="source-chip">
                <span>
                  {source.sources.length} source{" "}
                  {source.sources.length === 1 ? "message" : "messages"} · room
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
            <PromptInput
              targetKey={tab.id}
              label="Message"
              placeholder={
                !room.workspace
                  ? "Select a repository to get started…"
                  : busy
                    ? "Wait for this turn, or stop it."
                    : `Message ${tab.title}`
              }
              submitLabel="Send"
              value={draft}
              onChange={onDraftChange}
              disabled={
                disabled ||
                busy ||
                !room.workspace ||
                tab.status === "unavailable" ||
                tab.status === "resume_failed" ||
                modelMissing
              }
              onSubmit={send}
            />
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
