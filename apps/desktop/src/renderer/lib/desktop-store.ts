import { useSyncExternalStore } from "react";
import {
  PROTOCOL_VERSION,
  type Health,
  type Result,
  type Room,
  type Snapshot,
} from "../../shared/contracts";
import type { HarnessId, HarnessState, Tab } from "../../shared/tabs";
import type { RoomNotice } from "../../shared/collaboration";

interface ViewState {
  /** The supervisor's latest snapshot with in-flight optimistic edits applied. */
  snapshot: Snapshot | null;
  health: Health;
  error: string | null;
  /** Keys of commands still in flight. */
  busy: ReadonlySet<string>;
}
let state: ViewState = {
  snapshot: null,
  health: { status: "connecting", message: "Connecting to local supervisor" },
  error: null,
  busy: new Set(),
};
// The last snapshot the supervisor confirmed, and edits shown ahead of their replies.
let confirmed: Snapshot | null = null;
const overlays = new Set<(snapshot: Snapshot) => Snapshot>();
const listeners = new Set<() => void>();
const emit = (patch: Partial<ViewState>) => {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
};
const project = () =>
  confirmed &&
  [...overlays].reduce((snapshot, apply) => apply(snapshot), confirmed);

export function acceptSnapshot(snapshot: Snapshot) {
  // A delayed command reply must never roll the UI back over newer supervisor events.
  if (snapshot.protocolVersion !== PROTOCOL_VERSION) {
    emit({ error: "Desktop protocol mismatch. Restart the updated app." });
    return;
  }
  if (!confirmed || snapshot.revision > confirmed.revision) {
    confirmed = snapshot;
    emit({ snapshot: project() });
  }
}

interface PerformOptions {
  onNotice?: (notice: RoomNotice) => void;
  /**
   * Shows the expected result immediately and is dropped once the supervisor answers, so a
   * failure rolls it back. It is reapplied over every snapshot that arrives meanwhile, so it
   * must be idempotent.
   */
  optimistic?: (snapshot: Snapshot) => Snapshot;
  /** A repeat with the same key is ignored while the first is still in flight. */
  key?: string;
  /** Commands in one lane run one after another, in the order they were asked for. */
  lane?: string;
}

const inFlight = new Set<string>();
const lanes = new Map<string, Promise<unknown>>();

/** True while a command with this key is in flight. */
export const isInFlight = (key: string) => state.busy.has(key);

/** Runs a command without blocking the rest of the UI. */
export async function perform(
  operation: () => Promise<Result>,
  { onNotice, optimistic, key, lane }: PerformOptions = {},
): Promise<Snapshot | null> {
  if (key) {
    if (inFlight.has(key)) return null;
    inFlight.add(key);
  }
  // Each call gets its own overlay, even when two share one function.
  const overlay = optimistic && ((snapshot: Snapshot) => optimistic(snapshot));
  if (overlay) overlays.add(overlay);
  emit({
    error: null,
    ...(key ? { busy: new Set(inFlight) } : {}),
    ...(overlay ? { snapshot: project() } : {}),
  });
  // A lane's next command starts once the one before it has answered, however it went.
  const before = lane ? lanes.get(lane) : undefined;
  const queued = before ? before.catch(() => {}).then(operation) : operation();
  if (lane) lanes.set(lane, queued);
  try {
    const result = await queued;
    if (!result.ok) {
      emit({ error: result.error });
      return null;
    }
    acceptSnapshot(result.snapshot);
    if (result.notice) onNotice?.(result.notice);
    return result.snapshot;
  } catch {
    emit({
      error:
        "Could not reach the local supervisor. Restart the app to recover recorded work.",
    });
    return null;
  } finally {
    if (lane && lanes.get(lane) === queued) lanes.delete(lane);
    if (key) inFlight.delete(key);
    if (overlay) overlays.delete(overlay);
    emit({
      ...(key ? { busy: new Set(inFlight) } : {}),
      ...(overlay ? { snapshot: project() } : {}),
    });
  }
}

/** Returns `snapshot` with one room replaced by `update(room)`. */
export function withRoom(
  snapshot: Snapshot,
  roomId: string,
  update: (room: Room) => Room,
): Snapshot {
  return {
    ...snapshot,
    rooms: snapshot.rooms.map((room) =>
      room.id === roomId ? update(room) : room,
    ),
  };
}

/** Returns `snapshot` with one open tab replaced by `update(tab)`. */
export function withTab(
  snapshot: Snapshot,
  roomId: string,
  tabId: string,
  update: (tab: Tab) => Tab,
): Snapshot {
  return withRoom(snapshot, roomId, (room) => ({
    ...room,
    tabs: room.tabs.map((tab) => (tab.id === tabId ? update(tab) : tab)),
  }));
}

/** Returns `snapshot` with one harness replaced by `update(harness)`. */
export function withHarness(
  snapshot: Snapshot,
  id: HarnessId,
  update: (harness: HarnessState) => HarnessState,
): Snapshot {
  return {
    ...snapshot,
    harnesses: snapshot.harnesses?.map((harness) =>
      harness.id === id ? update(harness) : harness,
    ),
  };
}

/** The current view outside React. */
export const readDesktop = () => state;

export const dismissError = () => emit({ error: null });
export function useDesktop() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    // Static renders (component tests) read the same view.
    () => state,
  );
}

export function connectDesktop() {
  if (!window.desktop) {
    emit({
      health: { status: "stale", message: "Desktop bridge unavailable" },
      error:
        "Open this interface using Electron: run npm run dev from the project folder.",
    });
    return () => {};
  }
  const unsubscribeSnapshot = window.desktop.onSnapshot(acceptSnapshot);
  const unsubscribeHealth = window.desktop.onHealth((health) =>
    emit({ health }),
  );
  void perform(() => window.desktop.getSnapshot()).then((snapshot) => {
    if (snapshot && state.health.status === "connecting")
      emit({
        health: { status: "live", message: "Local supervisor connected" },
      });
  });
  return () => {
    unsubscribeSnapshot();
    unsubscribeHealth();
  };
}
