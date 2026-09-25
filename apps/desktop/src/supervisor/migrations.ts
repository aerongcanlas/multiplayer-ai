import { existsSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export type Step = ((db: DatabaseSync) => void) | null;

// Ordered, append-only schema steps keyed by `PRAGMA user_version` (KTD3). Index i moves a
// journal from version i to i + 1. Step 2 is unused: a `feat/desktop-agent-connections` build
// also wrote version 2 with a different table set, so this line of steps continues at 3.
export const steps: readonly Step[] = [
  // 1: the schema `main` created without a version number.
  (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(execution_id, seq));
      CREATE TABLE IF NOT EXISTS outbox (event_id TEXT PRIMARY KEY REFERENCES events(id), status TEXT NOT NULL DEFAULT 'local_only');
      CREATE TABLE IF NOT EXISTS runner_sessions (execution_id TEXT NOT NULL, task_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL);
    `),
  // 2: reserved, see above.
  null,
  // 3: chat tabs, their transcripts, and app settings.
  (db) => {
    db.exec(`
      CREATE TABLE tabs (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, position INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE transcript_entries (tab_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, PRIMARY KEY (tab_id, seq));
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    rewriteState(db, (state) => ({ ...state, protocolVersion: 2 }), 2);
  },
  // 4: the lead/specialist run is gone; its executions, summaries, and event log go with it.
  (db) => {
    rewriteState(
      db,
      (state) => ({
        ...state,
        provider: undefined,
        rooms: (Array.isArray(state.rooms) ? state.rooms : []).map((room) => ({
          ...(room as StateBody),
          executions: undefined,
          summaries: undefined,
        })),
      }),
      2,
    );
    db.exec(`
      DROP TABLE IF EXISTS runner_sessions;
      DROP TABLE IF EXISTS outbox;
      DROP TABLE IF EXISTS events;
    `);
  },
  // 5: sub-agent cards and their entries page by kind and agent key. Every earlier row is a lead
  // entry, so its agent key stays null.
  (db) =>
    db.exec(`
      ALTER TABLE transcript_entries ADD COLUMN kind TEXT NOT NULL DEFAULT '';
      ALTER TABLE transcript_entries ADD COLUMN agent_key TEXT;
      UPDATE transcript_entries SET kind = coalesce(json_extract(body, '$.kind'), '');
      CREATE INDEX transcript_entries_agent ON transcript_entries (tab_id, agent_key, seq);
      CREATE INDEX transcript_entries_kind ON transcript_entries (tab_id, kind);
    `),
];

export const JOURNAL_SCHEMA_VERSION = steps.length;

type StateBody = Record<string, unknown>;
function rewriteState(
  db: DatabaseSync,
  change: (state: StateBody) => StateBody,
  version: number,
) {
  const row = db.prepare("SELECT body FROM state WHERE id = 1").get();
  if (!row) return;
  const state = change(JSON.parse(row.body as string) as StateBody);
  db.prepare("UPDATE state SET version = ?, body = ? WHERE id = 1").run(
    version,
    JSON.stringify(state),
  );
}

const tableNames = (db: DatabaseSync) =>
  new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name)),
  );

/** Brings a journal to the latest schema. Returns the version it started from. */
export function migrate(
  db: DatabaseSync,
  file: string,
  list: readonly Step[] = steps,
): number {
  const stored = Number(
    db.prepare("PRAGMA user_version").get()?.user_version ?? 0,
  );
  if (stored > list.length)
    throw new Error(
      "This journal was created by a newer app version. Update the app to open it.",
    );
  const tables = tableNames(db);
  // `feat/desktop-agent-connections` journals carry its connection tables at version 2.
  const branchShaped = stored === 2 && tables.has("connections");
  // `main` never set a version; an existing state table marks its baseline.
  const start = branchShaped
    ? 0
    : stored === 0 && tables.has("state")
      ? 1
      : stored;
  if (start === list.length && !branchShaped) return stored;
  if (tables.has("state")) backup(db, file);
  // Steps drop and rebuild tables that reference each other; enforcement resumes afterwards.
  // (The pragma is a no-op inside a transaction, so it is set before BEGIN.)
  const foreignKeys = Number(
    db.prepare("PRAGMA foreign_keys").get()?.foreign_keys ?? 0,
  );
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (branchShaped) rebuildBranchJournal(db, tables);
    for (let version = start; version < list.length; version++)
      list[version]?.(db);
    db.exec(`PRAGMA user_version = ${list.length}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
  return stored;
}

// VACUUM INTO copies committed pages including those still in the WAL.
function backup(db: DatabaseSync, file: string) {
  const target = `${file}.bak`;
  if (existsSync(target)) rmSync(target);
  db.prepare("VACUUM INTO ?").run(target);
}

// Keeps the rooms, chat, suggestions, and repository selections of a branch-shaped journal and
// drops everything the branch recorded about its runs.
function rebuildBranchJournal(db: DatabaseSync, tables: Set<string>) {
  const row = db.prepare("SELECT body FROM state WHERE id = 1").get();
  const workspaces = tables.has("workspaces")
    ? db.prepare("SELECT id, body FROM workspaces").all()
    : [];
  for (const table of tables)
    if (!table.startsWith("sqlite_")) db.exec(`DROP TABLE "${table}"`);
  steps[0]!(db);
  const insertWorkspace = db.prepare(
    "INSERT INTO workspaces (id, body) VALUES (?, ?)",
  );
  for (const workspace of workspaces)
    insertWorkspace.run(String(workspace.id), String(workspace.body));
  if (!row) return;
  const state = JSON.parse(row.body as string) as StateBody;
  const rooms = Array.isArray(state.rooms) ? state.rooms : [];
  const kept = {
    protocolVersion: 1,
    revision: typeof state.revision === "number" ? state.revision : 0,
    hostId: state.hostId,
    sync: "local-only",
    rooms: rooms.map((value) => {
      const room = value as StateBody;
      return {
        ...(room.shared ? { shared: room.shared } : {}),
        id: room.id,
        name: room.name,
        createdAt: room.createdAt,
        workspace: room.workspace ?? null,
        messages: Array.isArray(room.messages) ? room.messages : [],
        suggestions: Array.isArray(room.suggestions) ? room.suggestions : [],
      };
    }),
  };
  db.prepare("INSERT INTO state (id, version, body) VALUES (1, 1, ?)").run(
    JSON.stringify(kept),
  );
}
