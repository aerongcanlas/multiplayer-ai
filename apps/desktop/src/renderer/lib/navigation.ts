/** Where the main area is: a room, its active tab, and another host's tab open instead. */
export interface Location {
  roomId: string;
  tabId: string | null;
  sharedTabId: string | null;
}

export interface History {
  entries: Location[];
  index: number;
}

const LIMIT = 100;

export const emptyHistory: History = { entries: [], index: -1 };

const same = (a: Location | undefined, b: Location) =>
  a?.roomId === b.roomId &&
  a.tabId === b.tabId &&
  a.sharedTabId === b.sharedTabId;

/** Records a visit: forward entries drop, and a repeat of the current place is ignored. */
export function visit(history: History, location: Location): History {
  if (same(history.entries[history.index], location)) return history;
  const entries = [
    ...history.entries.slice(0, history.index + 1),
    location,
  ].slice(-LIMIT);
  return { entries, index: entries.length - 1 };
}

/**
 * The history after one step back (-1) or forward (1), skipping places that no longer exist, and
 * the place it lands on; null when there is nowhere to go.
 */
export function step(
  history: History,
  by: -1 | 1,
  exists: (location: Location) => boolean,
): { history: History; location: Location } | null {
  for (
    let index = history.index + by;
    index >= 0 && index < history.entries.length;
    index += by
  ) {
    const location = history.entries[index]!;
    if (exists(location)) return { history: { ...history, index }, location };
  }
  return null;
}
