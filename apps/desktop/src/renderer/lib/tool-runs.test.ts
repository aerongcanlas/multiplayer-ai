import test from "node:test";
import assert from "node:assert/strict";
import type { TranscriptEntry } from "../../shared/tabs";
import { groupToolRuns } from "./tool-runs";

const entry = (
  seq: number,
  kind: TranscriptEntry["kind"],
): TranscriptEntry => ({
  id: crypto.randomUUID(),
  tabId: crypto.randomUUID(),
  seq,
  turnId: null,
  kind,
  share: "summary",
  summary: `${kind} ${seq}`,
  createdAt: "2026-10-02T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
});
const shape = (entries: TranscriptEntry[]) =>
  groupToolRuns(entries).map((row) =>
    Array.isArray(row) ? row.map((item) => item.seq) : row.seq,
  );

test("consecutive tool entries fold into one row", () => {
  assert.deepEqual(
    shape([
      entry(1, "user"),
      entry(2, "tool"),
      entry(3, "tool"),
      entry(4, "tool"),
      entry(5, "assistant"),
      entry(6, "tool"),
      entry(7, "tool"),
    ]),
    [1, [2, 3, 4], 5, [6, 7]],
  );
});

test("a lone tool entry stays its own row", () => {
  assert.deepEqual(
    shape([entry(1, "tool"), entry(2, "assistant"), entry(3, "tool")]),
    [1, 2, 3],
  );
  assert.deepEqual(shape([]), []);
});
