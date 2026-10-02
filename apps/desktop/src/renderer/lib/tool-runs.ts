import type { TranscriptEntry } from "../../shared/tabs";

/** A transcript row: one entry, or a run of back-to-back tool entries shown as one. */
export type TranscriptRow = TranscriptEntry | TranscriptEntry[];

/** Folds each run of two or more consecutive tool entries into a single row. */
export function groupToolRuns(entries: TranscriptEntry[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const entry of entries) {
    const previous = rows.at(-1);
    if (entry.kind !== "tool" || !previous) rows.push(entry);
    else if (Array.isArray(previous)) previous.push(entry);
    else if (previous.kind === "tool")
      rows[rows.length - 1] = [previous, entry];
    else rows.push(entry);
  }
  return rows;
}
