import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type Snapshot,
  type PrivateWorkspace,
  type ProgressEvent,
  type Room,
} from "../shared/contracts";
import type { Tab, TranscriptEntry, TranscriptPage } from "../shared/tabs";
import { migrate } from "./migrations";

export class Journal {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    try {
      // Migrate before switching to WAL so a refused journal is left byte-for-byte untouched.
      migrate(this.db, file);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.db.exec("PRAGMA journal_mode = WAL");
  }

  load(): Snapshot {
    const row = this.db.prepare("SELECT body FROM state WHERE id = 1").get();
    if (row) {
      const stored = JSON.parse(row.body as string) as Snapshot;
      const tabs = this.db
        .prepare("SELECT body FROM tabs ORDER BY position")
        .all()
        .map((tab) => JSON.parse(tab.body as string) as Tab);
      return {
        ...stored,
        protocolVersion: PROTOCOL_VERSION,
        rooms: stored.rooms.map((room) => ({
          ...room,
          tabs: tabs.filter((tab) => tab.roomId === room.id),
        })),
      };
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
          tabs: [],
        },
      ],
    };
  }

  save(
    snapshot: Snapshot,
    events: ProgressEvent[] = [],
    workspace?: PrivateWorkspace,
  ) {
    this.write(() => {
      // Tabs live in their own table; the state body keeps rooms without them.
      const body = {
        ...snapshot,
        rooms: snapshot.rooms.map((room): Partial<Room> => ({
          ...room,
          tabs: undefined,
        })),
      };
      this.db
        .prepare(
          "INSERT INTO state (id, version, body) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, body=excluded.body",
        )
        .run(PROTOCOL_VERSION, JSON.stringify(body));
      this.db.exec("DELETE FROM tabs");
      const insertTab = this.db.prepare(
        "INSERT INTO tabs (id, room_id, position, body) VALUES (?, ?, ?, ?)",
      );
      let position = 0;
      for (const room of snapshot.rooms)
        for (const tab of room.tabs)
          insertTab.run(tab.id, room.id, position++, JSON.stringify(tab));
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
    });
  }

  private write(body: () => void) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      body();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Upserts coalesced entries; an entry keeps its seq as it grows. */
  saveTranscript(entries: TranscriptEntry[]) {
    if (!entries.length) return;
    this.write(() => {
      const upsert = this.db.prepare(
        "INSERT INTO transcript_entries (tab_id, seq, id, body) VALUES (?, ?, ?, ?) ON CONFLICT(tab_id, seq) DO UPDATE SET body=excluded.body",
      );
      for (const entry of entries)
        upsert.run(entry.tabId, entry.seq, entry.id, JSON.stringify(entry));
    });
  }

  transcriptPage(
    tabId: string,
    beforeSeq?: number,
    limit = 200,
  ): TranscriptPage {
    const rows = this.db
      .prepare(
        "SELECT body FROM transcript_entries WHERE tab_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
      )
      .all(tabId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const entries = rows
      .slice(0, limit)
      .map((row) => JSON.parse(row.body as string) as TranscriptEntry)
      .reverse();
    return {
      tabId,
      entries,
      nextSeq: rows.length > limit ? (entries[0]?.seq ?? null) : null,
    };
  }

  /** Entries that still wait on the host, newest last. */
  pendingEntries(tabId: string): TranscriptEntry[] {
    return this.db
      .prepare(
        "SELECT body FROM transcript_entries WHERE tab_id = ? AND json_extract(body, '$.state') = 'pending' ORDER BY seq",
      )
      .all(tabId)
      .map((row) => JSON.parse(row.body as string) as TranscriptEntry);
  }

  lastSeq(tabId: string): number {
    return Number(
      this.db
        .prepare(
          "SELECT MAX(seq) AS seq FROM transcript_entries WHERE tab_id = ?",
        )
        .get(tabId)?.seq ?? 0,
    );
  }

  deleteTranscript(tabId: string) {
    this.db
      .prepare("DELETE FROM transcript_entries WHERE tab_id = ?")
      .run(tabId);
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key);
    return row ? (JSON.parse(row.value as string) as T) : undefined;
  }

  setSetting(key: string, value: unknown) {
    if (value === undefined)
      this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    else
      this.db
        .prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(key, JSON.stringify(value));
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
