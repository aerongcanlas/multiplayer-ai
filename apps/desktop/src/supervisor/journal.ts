import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type Snapshot,
  type PrivateWorkspace,
  type ProgressEvent,
} from "../shared/contracts";

export class Journal {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(execution_id, seq));
      CREATE TABLE IF NOT EXISTS outbox (event_id TEXT PRIMARY KEY REFERENCES events(id), status TEXT NOT NULL DEFAULT 'local_only');
      CREATE TABLE IF NOT EXISTS runner_sessions (execution_id TEXT NOT NULL, task_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL);
    `);
  }

  load(): Snapshot {
    const row = this.db
      .prepare("SELECT version, body FROM state WHERE id = 1")
      .get();
    if (row) {
      if (row.version !== PROTOCOL_VERSION)
        throw new Error(
          "This journal was created by an incompatible app version.",
        );
      return JSON.parse(row.body as string) as Snapshot;
    }
    const now = new Date().toISOString();
    return {
      protocolVersion: PROTOCOL_VERSION,
      revision: 0,
      hostId: randomUUID(),
      sync: "local-only",
      rooms: [
        {
          id: randomUUID(),
          name: "My workspace",
          createdAt: now,
          workspace: null,
          messages: [],
          suggestions: [],
          executions: [],
          summaries: [],
        },
      ],
    };
  }

  save(
    snapshot: Snapshot,
    events: ProgressEvent[] = [],
    workspace?: PrivateWorkspace,
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO state (id, version, body) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, body=excluded.body",
        )
        .run(PROTOCOL_VERSION, JSON.stringify(snapshot));
      if (workspace)
        this.db
          .prepare("INSERT OR REPLACE INTO workspaces (id, body) VALUES (?, ?)")
          .run(workspace.id, JSON.stringify(workspace));
      const insertEvent = this.db.prepare(
        "INSERT OR IGNORE INTO events (id, execution_id, seq, body) VALUES (?, ?, ?, ?)",
      );
      const insertOutbox = this.db.prepare(
        "INSERT OR IGNORE INTO outbox (event_id) VALUES (?)",
      );
      for (const event of events) {
        insertEvent.run(
          event.id,
          event.executionId,
          event.seq,
          JSON.stringify(event),
        );
        insertOutbox.run(event.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getWorkspace(id: string): PrivateWorkspace | null {
    const row = this.db
      .prepare("SELECT body FROM workspaces WHERE id = ?")
      .get(id);
    return row ? (JSON.parse(row.body as string) as PrivateWorkspace) : null;
  }

  eventCount(): number {
    return Number(
      this.db.prepare("SELECT COUNT(*) AS count FROM events").get()?.count ?? 0,
    );
  }

  saveSession(executionId: string, taskId: string, threadId: string) {
    this.db
      .prepare(
        "INSERT INTO runner_sessions (execution_id, task_id, thread_id) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET thread_id=excluded.thread_id",
      )
      .run(executionId, taskId, threadId);
  }

  close() {
    this.db.close();
  }
}
