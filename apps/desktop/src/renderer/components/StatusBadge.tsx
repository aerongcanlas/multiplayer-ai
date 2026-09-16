import type { TaskStatus } from "../../shared/contracts";

export function StatusBadge({
  status,
  stale = false,
}: {
  status: TaskStatus;
  stale?: boolean;
}) {
  const label =
    stale && status === "running" ? "stale" : status.replaceAll("_", " ");
  return (
    <span
      className={`status-badge status-${stale && status === "running" ? "blocked" : status}`}
    >
      <span aria-hidden="true" />
      {label}
    </span>
  );
}

export function timeLabel(value: string) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function durationLabel(start: string, end: string) {
  const seconds = Math.max(
    0,
    Math.floor((Date.parse(end) - Date.parse(start)) / 1000),
  );
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
