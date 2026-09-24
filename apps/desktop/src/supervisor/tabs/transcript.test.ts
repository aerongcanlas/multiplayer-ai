import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { TranscriptWriter, oneLine } from "./transcript";
import type { TranscriptBatch, TranscriptEntry } from "../../shared/tabs";

function setup(lastSeq = 0) {
  const saved: TranscriptEntry[][] = [];
  const batches: TranscriptBatch[][] = [];
  const writer = new TranscriptWriter(
    {
      saveTranscript: (entries) => saved.push(structuredClone(entries)),
      lastSeq: () => lastSeq,
    },
    (items) => batches.push(items),
    20,
  );
  return {
    writer,
    saved,
    batches,
    roomId: randomUUID(),
    tabId: randomUUID(),
    turnId: randomUUID(),
  };
}

test("streamed deltas coalesce into one entry that persists at flush time", async () => {
  const { writer, saved, batches, roomId, tabId, turnId } = setup();
  for (const delta of ["Hel", "lo", " world"])
    writer.text(roomId, tabId, turnId, "item-1", "assistant", delta);
  assert.equal(saved.length, 0);
  await wait(40);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].length, 1);
  assert.equal(saved[0][0].summary, "Hello world");
  assert.equal(saved[0][0].share, "full");
  assert.equal(batches[0][0].roomId, roomId);
  assert.equal(batches[0][0].entries[0].seq, 1);
  writer.text(roomId, tabId, turnId, "item-1", "assistant", "Final", true);
  writer.flush();
  assert.equal(saved[1][0].summary, "Final");
  assert.equal(saved[1][0].seq, 1);
  writer.close();
});

test("seq continues after stored entries and share levels follow the kind", () => {
  const { writer, saved, roomId, tabId, turnId } = setup(41);
  writer.append(roomId, tabId, { turnId, kind: "user", summary: "Go" });
  writer.text(roomId, tabId, turnId, "r", "reasoning", "Thinking");
  writer.tool(roomId, tabId, turnId, "cmd", "cat .env\n  | head", "SECRET=1");
  writer.tool(roomId, tabId, turnId, "cmd", "cat .env", "SECRET=1\nexit 0");
  writer.flush();
  const [user, reasoning, tool] = saved[0];
  assert.deepEqual([user.seq, reasoning.seq, tool.seq], [42, 43, 44]);
  assert.equal(reasoning.share, "none");
  assert.equal(tool.share, "summary");
  // Output lives only in local detail; the summary is one line.
  assert.equal(tool.summary, "cat .env");
  assert.equal(tool.detail, "SECRET=1\nexit 0");
  assert.equal(oneLine("a\nb   c"), "a b c");
  writer.close();
});

test("released entries leave memory while pending ones stay editable", () => {
  const { writer, roomId, tabId, turnId } = setup();
  const done = writer.append(roomId, tabId, {
    turnId,
    kind: "assistant",
    summary: "Done",
  });
  const pending = writer.append(roomId, tabId, {
    turnId,
    kind: "approval",
    summary: "Run command",
    state: "pending",
  });
  writer.release(tabId);
  assert.equal(writer.entry(done.id), undefined);
  assert.equal(writer.entry(pending.id)?.state, "pending");
  assert.deepEqual(
    writer.pending(tabId).map((entry) => entry.id),
    [pending.id],
  );
  writer.forget(tabId);
  assert.equal(writer.entry(pending.id), undefined);
  writer.close();
});
