import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Intent, TaskState } from "./core/types.js";

export const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      status TEXT NOT NULL,
      state TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX intents_pending ON intents (status, task_id, id);
    CREATE TABLE commands (
      id TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      request TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `,
};

export class SchemaTooNewError extends Error {}

export interface StoredIntent {
  readonly id: number;
  readonly taskID: string;
  readonly intent: Intent;
  readonly attempts: number;
  readonly nextAt: number;
}

export interface StoredCommand {
  readonly request: string;
  readonly result: unknown;
}

interface IntentRow {
  id: number;
  task_id: string;
  payload: string;
  attempts: number;
  next_at: number;
}

export class Store {
  readonly #db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const existed = existsSync(file);
    this.#db = new DatabaseSync(file);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.#migrate(file, existed);
  }

  #migrate(file: string, existed: boolean): void {
    const version = Number((this.#db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version > SCHEMA_VERSION) {
      this.#db.close();
      throw new SchemaTooNewError(`база ${file} версии ${version}, код знает только до ${SCHEMA_VERSION}; обнови opencode-orchestrator`);
    }
    if (version === SCHEMA_VERSION) return;

    if (existed && version > 0) copyFileSync(file, `${file}.bak-v${version}`);
    for (let next = version + 1; next <= SCHEMA_VERSION; next++) {
      this.transaction(() => {
        this.#db.exec(MIGRATIONS[next] ?? "");
        this.#db.exec(`PRAGMA user_version = ${next}`);
      });
    }
  }

  close(): void {
    this.#db.close();
  }

  transaction<Result>(work: () => Result): Result {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  salt(): string {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'salt'").get() as { value: string } | undefined;
    if (row) return row.value;

    const salt = randomBytes(16).toString("hex");
    this.#db.prepare("INSERT INTO meta (key, value) VALUES ('salt', ?)").run(salt);
    return salt;
  }

  insertTask(state: TaskState, now: number): void {
    const seq = Number((this.#db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM tasks").get() as { seq: number }).seq);
    this.#db
      .prepare("INSERT INTO tasks (id, seq, status, state, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
      .run(state.id, seq, state.status, JSON.stringify(state), now, now);
  }

  saveTask(state: TaskState, now: number): void {
    this.#db
      .prepare("UPDATE tasks SET status = ?, state = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(state.status, JSON.stringify(state), now, state.id);
  }

  task(id: string): TaskState | undefined {
    const row = this.#db.prepare("SELECT state FROM tasks WHERE id = ?").get(id) as { state: string } | undefined;
    return row ? (JSON.parse(row.state) as TaskState) : undefined;
  }

  tasks(): TaskState[] {
    const rows = this.#db.prepare("SELECT state FROM tasks ORDER BY seq").all() as { state: string }[];
    return rows.map((row) => JSON.parse(row.state) as TaskState);
  }

  addIntents(taskID: string, intents: readonly Intent[], now: number): void {
    const insert = this.#db.prepare("INSERT INTO intents (task_id, kind, payload, status, created_at) VALUES (?, ?, ?, 'pending', ?)");
    for (const intent of intents) insert.run(taskID, intent.kind, JSON.stringify(intent), now);
  }

  cancelPendingIntents(taskID: string): void {
    this.#db.prepare("UPDATE intents SET status = 'cancelled' WHERE task_id = ? AND status = 'pending'").run(taskID);
  }

  /** The oldest pending intent of every task: intents of one task run strictly in order. */
  headIntents(): StoredIntent[] {
    const rows = this.#db
      .prepare(
        `SELECT i.id, i.task_id, i.payload, i.attempts, i.next_at FROM intents i
         WHERE i.status = 'pending' AND i.id = (
           SELECT MIN(j.id) FROM intents j WHERE j.task_id = i.task_id AND j.status = 'pending')
         ORDER BY i.id`,
      )
      .all() as unknown as IntentRow[];
    return rows.map((row) => ({
      id: row.id,
      taskID: row.task_id,
      intent: JSON.parse(row.payload) as Intent,
      attempts: row.attempts,
      nextAt: row.next_at,
    }));
  }

  isIntentPending(id: number): boolean {
    const row = this.#db.prepare("SELECT status FROM intents WHERE id = ?").get(id) as { status: string } | undefined;
    return row?.status === "pending";
  }

  finishIntent(id: number, status: "done" | "failed", error?: string): void {
    this.#db.prepare("UPDATE intents SET status = ?, last_error = ? WHERE id = ?").run(status, error ?? null, id);
  }

  deferIntent(id: number, nextAt: number, error: string): void {
    this.#db.prepare("UPDATE intents SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE id = ?").run(nextAt, error, id);
  }

  command(id: string): StoredCommand | undefined {
    const row = this.#db.prepare("SELECT request, result FROM commands WHERE id = ?").get(id) as
      | { request: string; result: string }
      | undefined;
    return row ? { request: row.request, result: JSON.parse(row.result) } : undefined;
  }

  saveCommand(input: { id: string; method: string; request: string; result: unknown; now: number }): void {
    this.#db
      .prepare("INSERT INTO commands (id, method, request, result, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.id, input.method, input.request, JSON.stringify(input.result), input.now);
  }

  countIntents(): Record<string, number> {
    const rows = this.#db.prepare("SELECT status, COUNT(*) AS count FROM intents GROUP BY status").all() as {
      status: string;
      count: number;
    }[];
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  }
}
