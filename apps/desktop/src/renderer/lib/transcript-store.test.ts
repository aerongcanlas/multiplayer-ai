import test from "node:test";
import assert from "node:assert/strict";
import type { SharedEntry, SharedTab } from "../../shared/collaboration";
import { acceptShared, sharedTranscript } from "./transcript-store";
import {
  ageLabel,
  asTranscriptEntry,
  sharedGroups,
  switchCaption,
} from "./read-along";

const record = (patch: Partial<SharedTab> = {}): SharedTab => ({
  tabId: crypto.randomUUID(),
  roomId: crypto.randomUUID(),
  hostId: crypto.randomUUID(),
  hostName: "Alice",
  deviceId: "alice-desktop",
  title: "Tab",
  harness: "codex",
  model: "m",
  status: "running",
  switchOn: true,
  rev: 1,
  updatedAt: "2026-09-26T00:00:00.000Z",
  ...patch,
});
const entry = (seq: number, text: string, version = 1): SharedEntry => ({
  seq,
  kind: "assistant",
  share: "full",
  summary: text,
  text,
  version,
  rev: 1,
  updatedAt: "2026-09-26T00:00:00.000Z",
});

test("shared batches merge by seq, never regress to an older version, and clear on account change", () => {
  const tab = record();
  const base = { roomId: tab.roomId, tabId: tab.tabId, record: tab, now: "" };
  acceptShared({
    type: "entries",
    ...base,
    entries: [entry(2, "b"), entry(1, "a")],
    earlierSeq: 1,
  });
  acceptShared({ type: "entries", ...base, entries: [entry(2, "b grown", 3)] });
  // A delayed publish of older text arrives after the newer one.
  acceptShared({ type: "entries", ...base, entries: [entry(2, "b", 2)] });
  const held = sharedTranscript(tab.tabId);
  assert.deepEqual(
    held.entries.map((item) => item.text),
    ["a", "b grown"],
  );
  assert.equal(held.earlierSeq, 1);
  acceptShared({
    type: "status",
    roomId: tab.roomId,
    tabId: tab.tabId,
    state: "live",
  });
  assert.equal(sharedTranscript(tab.tabId).state, "live");
  acceptShared({ type: "clear" });
  assert.deepEqual(sharedTranscript(tab.tabId).entries, []);
});

test("ages come from server time and read reconnecting while offline", () => {
  const now = Date.parse("2026-09-26T00:00:30.000Z");
  assert.equal(
    ageLabel("2026-09-26T00:00:00.000Z", true, 0, now),
    "Updated 30s ago",
  );
  // The local clock runs 10 s behind the server.
  assert.equal(
    ageLabel("2026-09-26T00:00:00.000Z", true, 10_000, now),
    "Updated 40s ago",
  );
  assert.equal(
    ageLabel("2026-09-26T00:00:00.000Z", false, 0, now),
    "Reconnecting…",
  );
});

test("tabs group per host, with this account's other desktop labelled apart", () => {
  const alice = record();
  const alice2 = record({ hostId: alice.hostId });
  const mine = record({
    hostName: "Me",
    sameUser: true,
    deviceId: "second-desktop",
  });
  const groups = sharedGroups([alice, mine, alice2]);
  assert.deepEqual(
    groups.map((group) => [group.label, group.tabs.length]),
    [
      ["Alice", 2],
      ["You · another desktop", 1],
    ],
  );
});

test("shared entries map to transcript entries and the switch caption follows publisher status", () => {
  const mapped = asTranscriptEntry("t", {
    ...entry(4, "Full text"),
    summary: "Full",
  });
  assert.equal(mapped.summary, "Full text");
  assert.equal(mapped.seq, 4);
  assert.equal(switchCaption({ state: "publishing" }, true), "Publishing");
  assert.equal(
    switchCaption({ state: "paused", buffered: 3 }, true),
    "Paused · 3 waiting to publish",
  );
  assert.match(
    switchCaption({ state: "stopped", reason: "not_member" }, false),
    /no longer a member/,
  );
  assert.match(
    switchCaption({ state: "stopped", reason: "migration_missing" }, false),
    /migration/,
  );
  assert.equal(switchCaption(undefined, false), "Off · this tab is private");
});
