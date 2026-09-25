import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Journal } from "./journal";
import { JOURNAL_SCHEMA_VERSION, migrate, steps } from "./migrations";
import type { TranscriptEntry } from "../shared/tabs";

const directory = () => mkdtemp(join(tmpdir(), "multiplayer-journal-"));
const version = (file: string) => {
  const db = new DatabaseSync(file);
  try {
    return Number(db.prepare("PRAGMA user_version").get()?.user_version);
  } finally {
    db.close();
  }
};
const tables = (file: string) => {
  const db = new DatabaseSync(file);
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name));
  } finally {
    db.close();
  }
};

const now = new Date().toISOString();
const message = {
  id: randomUUID(),
  authorId: randomUUID(),
  authorName: "You",
  text: "Please add dark mode",
  createdAt: now,
};
const suggestion = {
  id: randomUUID(),
  prompt: "Add dark mode",
  contextVersion: 0,
  sourceMessageIds: [message.id],
  sources: [message],
  revision: 1,
  status: "draft",
  createdAt: now,
  updatedAt: now,
};
const roomBody = (id = randomUUID()) => ({
  id,
  name: "My workspace",
  createdAt: now,
  workspace: null,
  messages: [message],
  suggestions: [suggestion],
});

// The schema and body `main` wrote before journals had a version number.
function writeMainJournal(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE events (id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(execution_id, seq));
    CREATE TABLE outbox (event_id TEXT PRIMARY KEY REFERENCES events(id), status TEXT NOT NULL DEFAULT 'local_only');
    CREATE TABLE runner_sessions (execution_id TEXT NOT NULL, task_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL);
  `);
  const executionId = randomUUID();
  const room = {
    ...roomBody(),
    executions: [
      {
        id: executionId,
        status: "completed",
        tasks: [],
        events: [],
        evidence: [],
      },
    ],
    summaries: [{ version: 1, executionId, goal: "Inspect" }],
  };
  db.prepare("INSERT INTO state (id, version, body) VALUES (1, 1, ?)").run(
    JSON.stringify({
      protocolVersion: 1,
      revision: 7,
      hostId: randomUUID(),
      sync: "local-only",
      rooms: [room],
    }),
  );
  const eventId = randomUUID();
  db.prepare(
    "INSERT INTO events (id, execution_id, seq, body) VALUES (?, ?, 1, '{}')",
  ).run(eventId, executionId);
  db.prepare("INSERT INTO outbox (event_id) VALUES (?)").run(eventId);
  db.close();
  return room;
}

// The table set a `feat/desktop-agent-connections` build left at version 2.
function writeBranchJournal(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE events (id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(execution_id, seq));
    CREATE TABLE outbox (event_id TEXT PRIMARY KEY REFERENCES events(id), status TEXT NOT NULL DEFAULT 'local_only');
    CREATE TABLE connections (id TEXT PRIMARY KEY, body TEXT NOT NULL, removed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, execution_id TEXT NOT NULL, intent_id TEXT, body TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version = 2;
  `);
  const workspaceId = randomUUID();
  const room = {
    ...roomBody(),
    workspace: {
      id: workspaceId,
      name: "repo",
      branch: "main",
      revision: "abc",
      dirty: false,
    },
    executions: [{ id: randomUUID(), assignments: [], connections: [] }],
    summaries: [],
  };
  db.prepare("INSERT INTO state (id, version, body) VALUES (1, 2, ?)").run(
    JSON.stringify({
      protocolVersion: 2,
      revision: 3,
      hostId: randomUUID(),
      sync: "local-only",
      rooms: [room],
      connections: [{ id: "x" }],
    }),
  );
  db.prepare("INSERT INTO workspaces (id, body) VALUES (?, ?)").run(
    workspaceId,
    JSON.stringify({ ...room.workspace, path: "/tmp/repo" }),
  );
  db.prepare("INSERT INTO connections (id, body) VALUES ('x', '{}')").run();
  // Branch journals carry event rows that outbox rows reference.
  db.prepare(
    "INSERT INTO events (id, execution_id, seq, body) VALUES ('e1', 'x', 1, '{}')",
  ).run();
  db.prepare("INSERT INTO outbox (event_id) VALUES ('e1')").run();
  db.close();
  return room;
}

test("a journal written by main migrates with its rooms, chat, and suggestions", async () => {
  const file = join(await directory(), "execution-journal.sqlite");
  const room = writeMainJournal(file);
  const journal = new Journal(file);
  const snapshot = journal.load();
  journal.close();
  assert.equal(snapshot.protocolVersion, 2);
  assert.equal(snapshot.revision, 7);
  assert.equal(snapshot.rooms.length, 1);
  assert.deepEqual(snapshot.rooms[0].messages, room.messages);
  assert.deepEqual(snapshot.rooms[0].suggestions, room.suggestions);
  assert.deepEqual(snapshot.rooms[0].tabs, []);
  assert.equal(version(file), JOURNAL_SCHEMA_VERSION);
  assert.ok(existsSync(`${file}.bak`));
  // The backup is main's journal as it was.
  assert.equal(version(`${file}.bak`), 0);
  assert.ok(tables(file).includes("transcript_entries"));
  // The lead run's history is removed along with the run itself.
  assert.equal("executions" in snapshot.rooms[0], false);
  assert.equal("summaries" in snapshot.rooms[0], false);
  for (const table of ["events", "outbox", "runner_sessions"])
    assert.ok(!tables(file).includes(table));
});

test("a branch-shaped journal is backed up and rebuilt into the tab schema", async () => {
  const file = join(await directory(), "execution-journal.sqlite");
  const room = writeBranchJournal(file);
  const journal = new Journal(file);
  const snapshot = journal.load();
  const workspace = journal.getWorkspace(room.workspace.id);
  journal.close();
  assert.equal(snapshot.rooms[0].id, room.id);
  assert.deepEqual(snapshot.rooms[0].messages, room.messages);
  assert.deepEqual(snapshot.rooms[0].suggestions, room.suggestions);
  assert.equal("executions" in snapshot.rooms[0], false);
  assert.deepEqual(snapshot.rooms[0].tabs, []);
  assert.equal(workspace?.path, "/tmp/repo");
  assert.equal("connections" in snapshot, false);
  assert.ok(!tables(file).includes("connections"));
  assert.ok(!tables(file).includes("sessions"));
  assert.equal(version(`${file}.bak`), 2);
  assert.ok(tables(`${file}.bak`).includes("connections"));
});

test("a migrated journal reopens without re-running steps", async () => {
  const file = join(await directory(), "execution-journal.sqlite");
  writeMainJournal(file);
  new Journal(file).close();
  rmSync(`${file}.bak`);
  const journal = new Journal(file);
  assert.equal(journal.load().rooms.length, 1);
  journal.close();
  assert.equal(existsSync(`${file}.bak`), false);
  assert.equal(version(file), JOURNAL_SCHEMA_VERSION);
});

test("a fresh journal starts at the latest schema with the default room", async () => {
  const file = join(await directory(), "execution-journal.sqlite");
  const journal = new Journal(file);
  const snapshot = journal.load();
  journal.close();
  assert.equal(snapshot.rooms.length, 1);
  assert.equal(snapshot.rooms[0].name, "My workspace");
  assert.deepEqual(snapshot.rooms[0].tabs, []);
  assert.equal(version(file), JOURNAL_SCHEMA_VERSION);
  assert.equal(existsSync(`${file}.bak`), false);
});

test("a journal from a newer app is refused and left untouched", async () => {
  const file = join(await directory(), "execution-journal.sqlite");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE state (id INTEGER PRIMARY KEY, version INTEGER, body TEXT)",
  );
  db.exec("PRAGMA user_version = 99");
  db.close();
  const before = await readFile(file);
  assert.throws(() => new Journal(file), /created by a newer app version/);
  assert.deepEqual(await readFile(file), before);
  assert.equal(existsSync(`${file}.bak`), false);
});

test("a step failing mid-way rolls back and keeps the backup", async () => {
  const file = join(await directory(), "execution-journal.sqlite");
  writeMainJournal(file);
  const db = new DatabaseSync(file);
  const failing = [
    ...steps,
    (db: DatabaseSync) => {
      db.exec("CREATE TABLE half_done (value TEXT)");
      throw new Error("step failed");
    },
  ];
  assert.throws(() => migrate(db, file, failing), /step failed/);
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => String(row.name));
  assert.equal(
    Number(db.prepare("PRAGMA user_version").get()?.user_version),
    0,
  );
  db.close();
  assert.ok(!names.includes("half_done"));
  assert.ok(!names.includes("tabs"));
  assert.ok(existsSync(`${file}.bak`));
});

test("tabs, transcript pages, and settings persist", async () => {
  const file = join(await directory(), "execution-journal.sqlite");
  const journal = new Journal(file);
  const snapshot = journal.load();
  const room = snapshot.rooms[0];
  const tabId = randomUUID();
  room.tabs.push({
    id: tabId,
    roomId: room.id,
    title: "Codex 1",
    loadout: { harness: "codex", model: "m", planMode: false, access: "ask" },
    status: "idle",
    readAlong: false,
    createdAt: now,
    updatedAt: now,
  });
  journal.save(snapshot);
  const entries: TranscriptEntry[] = Array.from({ length: 5 }, (_, index) => ({
    id: randomUUID(),
    tabId,
    seq: index + 1,
    turnId: null,
    kind: "assistant",
    share: "full",
    summary: `entry ${index + 1}`,
    createdAt: now,
    updatedAt: now,
  }));
  journal.saveTranscript(entries);
  journal.saveTranscript([{ ...entries[4], summary: "entry 5 grown" }]);
  journal.setSetting("claude.notice", true);
  journal.close();

  const reopened = new Journal(file);
  assert.equal(reopened.load().rooms[0].tabs[0].id, tabId);
  const latest = reopened.transcriptPage(tabId, undefined, 2);
  assert.deepEqual(
    latest.entries.map((entry) => entry.summary),
    ["entry 4", "entry 5 grown"],
  );
  assert.equal(latest.nextSeq, 4);
  const older = reopened.transcriptPage(tabId, latest.nextSeq!, 10);
  assert.deepEqual(
    older.entries.map((entry) => entry.seq),
    [1, 2, 3],
  );
  assert.equal(older.nextSeq, null);
  assert.equal(reopened.lastSeq(tabId), 5);
  assert.equal(reopened.getSetting("claude.notice"), true);
  reopened.close();
});

const lead = (
  tabId: string,
  seq: number,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry => ({
  id: randomUUID(),
  tabId,
  seq,
  turnId: null,
  kind: "assistant",
  share: "full",
  summary: `entry ${seq}`,
  createdAt: now,
  updatedAt: now,
  ...extra,
});

test("step 5 backfills kind and leaves every earlier entry on the lead page", async () => {
  const file = join(await directory(), "execution-journal.sqlite");
  const db = new DatabaseSync(file);
  migrate(db, file, steps.slice(0, 4));
  const tabId = randomUUID();
  const insert = db.prepare(
    "INSERT INTO transcript_entries (tab_id, seq, id, body) VALUES (?, ?, ?, ?)",
  );
  const before = [
    lead(tabId, 1, { kind: "user" }),
    lead(tabId, 2),
    lead(tabId, 3, { kind: "turn" }),
  ];
  for (const entry of before)
    insert.run(tabId, entry.seq, entry.id, JSON.stringify(entry));
  db.close();

  const journal = new Journal(file);
  assert.equal(version(file), JOURNAL_SCHEMA_VERSION);
  assert.deepEqual(journal.transcriptPage(tabId).entries, before);
  journal.close();
  const check = new DatabaseSync(file);
  assert.deepEqual(
    check
      .prepare(
        "SELECT kind, agent_key FROM transcript_entries WHERE tab_id = ? ORDER BY seq",
      )
      .all(tabId)
      .map((row) => ({ ...row })),
    [
      { kind: "user", agent_key: null },
      { kind: "assistant", agent_key: null },
      { kind: "turn", agent_key: null },
    ],
  );
  check.close();
});

test("sub-agent entries page by agent key and cards load apart from both", async () => {
  const file = join(await directory(), "execution-journal.sqlite");
  const journal = new Journal(file);
  const tabId = randomUUID();
  const card = lead(tabId, 2, {
    kind: "agent",
    summary: "Explore the repo",
    agent: {
      key: "task-1",
      status: "running",
      background: false,
      startedAt: now,
      toolUses: 0,
    },
  });
  journal.saveTranscript([
    lead(tabId, 1, { kind: "user" }),
    card,
    lead(tabId, 3, { agentKey: "task-1", summary: "sub one" }),
    lead(tabId, 4, { kind: "tool", agentKey: "task-1", summary: "sub two" }),
    lead(tabId, 5),
    lead(tabId, 6, {
      kind: "approval",
      agentKey: "task-1",
      state: "pending",
      summary: "sub asks",
    }),
  ]);
  // A sub-agent's request also waits in the lead's view.
  assert.deepEqual(
    journal.transcriptPage(tabId).entries.map((entry) => entry.seq),
    [1, 5, 6],
  );
  assert.deepEqual(
    journal
      .transcriptPage(tabId, undefined, 200, "task-1")
      .entries.map((entry) => entry.summary),
    ["sub one", "sub two", "sub asks"],
  );
  assert.deepEqual(
    journal.agentCards(tabId).map((entry) => entry.id),
    [card.id],
  );
  journal.saveTranscript([
    {
      ...card,
      detail: "Found it",
      agent: { ...card.agent!, status: "completed", endedAt: now },
    },
  ]);
  const [saved] = journal.agentCards(tabId);
  assert.equal(saved.agent?.status, "completed");
  assert.equal(saved.detail, "Found it");
  assert.equal(journal.lastSeq(tabId), 6);
  journal.close();
});
