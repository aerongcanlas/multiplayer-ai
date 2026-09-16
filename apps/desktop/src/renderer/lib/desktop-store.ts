import { useSyncExternalStore } from "react";
import type { Health, Result, Snapshot } from "../../shared/contracts";
import type { RoomNotice } from "../../shared/collaboration";

interface ViewState {
  snapshot: Snapshot | null;
  health: Health;
  pending: number;
  error: string | null;
}
let state: ViewState = {
  snapshot: null,
  health: { status: "connecting", message: "Connecting to local supervisor" },
  pending: 0,
  error: null,
};
const listeners = new Set<() => void>();
const emit = (patch: Partial<ViewState>) => {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
};

export function acceptSnapshot(snapshot: Snapshot) {
  // A delayed command reply must never roll the UI back over newer supervisor events.
  if (snapshot.protocolVersion !== 1) {
    emit({ error: "Desktop protocol mismatch. Restart the updated app." });
    return;
  }
  if (!state.snapshot || snapshot.revision > state.snapshot.revision)
    emit({ snapshot });
}

export async function perform(
  operation: () => Promise<Result>,
  onNotice?: (notice: RoomNotice) => void,
): Promise<Snapshot | null> {
  emit({ pending: state.pending + 1, error: null });
  try {
    const result = await operation();
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
    emit({ pending: state.pending - 1 });
  }
}

export const dismissError = () => emit({ error: null });
export function useDesktop() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
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
