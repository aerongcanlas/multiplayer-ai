import { useState, type DragEvent, type KeyboardEvent } from "react";
import { getStored, setStored } from "./storage";

/**
 * Items in the host's saved order. Items the order does not name yet (a new room or chat) keep
 * their own relative order and go first or last.
 */
export function ordered<T>(
  items: T[],
  id: (item: T) => string,
  saved: string[],
  unknown: "first" | "last",
): T[] {
  const rank = new Map(saved.map((value, index) => [value, index]));
  const known = items
    .filter((item) => rank.has(id(item)))
    .sort((a, b) => rank.get(id(a))! - rank.get(id(b))!);
  const fresh = items.filter((item) => !rank.has(id(item)));
  return unknown === "first" ? [...fresh, ...known] : [...known, ...fresh];
}

/** `ids` with `moving` placed before or after `target`. */
export function moved(
  ids: string[],
  moving: string,
  target: string,
  after: boolean,
): string[] {
  if (moving === target) return ids;
  const rest = ids.filter((value) => value !== moving);
  const at = rest.indexOf(target);
  if (at === -1) return ids;
  rest.splice(after ? at + 1 : at, 0, moving);
  return rest;
}

/** A saved order of IDs, kept on this desktop under `key`. */
export function useSavedOrder(key: string) {
  const [orders, setOrders] = useState<Record<string, string[]>>({});
  const read = (): string[] => {
    if (orders[key]) return orders[key];
    try {
      const value: unknown = JSON.parse(getStored(key) ?? "[]");
      return Array.isArray(value)
        ? value.filter((item) => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  };
  const save = (ids: string[]) => {
    setOrders((current) => ({ ...current, [key]: ids }));
    setStored(key, JSON.stringify(ids));
  };
  return [read(), save] as const;
}

// The item being dragged and the list it belongs to; a drop elsewhere is ignored.
let dragging: { group: string; id: string } | null = null;

/**
 * Drag-and-drop and Alt+Up/Down reordering inside one list. `ids` is the list as shown;
 * `onMove` receives the new order.
 */
export function useReorder(
  group: string,
  ids: string[],
  onMove: (ids: string[]) => void,
) {
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const half = (event: DragEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY > rect.top + rect.height / 2;
  };
  return (id: string) => ({
    draggable: true,
    "data-drop":
      over?.id === id ? (over.after ? "after" : "before") : undefined,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      dragging = { group, id };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", "");
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (dragging?.group !== group) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      const after = half(event);
      if (over?.id !== id || over.after !== after) setOver({ id, after });
    },
    onDragLeave: () => {
      if (over?.id === id) setOver(null);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (dragging?.group !== group) return;
      event.preventDefault();
      event.stopPropagation();
      onMove(moved(ids, dragging.id, id, half(event)));
      setOver(null);
    },
    onDragEnd: () => {
      dragging = null;
      setOver(null);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key))
        return;
      const at = ids.indexOf(id);
      const target = ids[at + (event.key === "ArrowUp" ? -1 : 1)];
      if (!target) return;
      event.preventDefault();
      onMove(moved(ids, id, target, event.key === "ArrowDown"));
    },
  });
}
