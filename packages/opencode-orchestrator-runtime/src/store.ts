import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { describeIssue } from "./core/issue.js";
import { TaskStateSchema } from "./core/task-state.js";
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

/** A stored task no longer matches the shape the code expects; it cannot be continued safely. */
export class CorruptStateError extends Error {}

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

const VersionRow = z.object({ user_version: z.number() });
const ValueRow = z.object({ value: z.string() });
const NextSeqRow = z.object({ seq: z.number() });
const TaskRow = z.object({ id: z.string(), state: z.string() });
const IntentRow = z.object({
  id: z.number(),
  task_id: z.string(),
  payload: z.string(),
  attempts: z.number(),
  next_at: z.number(),
});
const StatusRow = z.object({ status: z.string() });
const CommandRow = z.object({ request: z.string(), result: z.string() });
const CountRow = z.object({ status: z.string(), count: z.number() });

export class Store {
  readonly #db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(file);
    this.#db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;",
    );
    this.#migrate(file);
  }

  #migrate(file: string): void {
    const version = this.#get(VersionRow, "PRAGMA user_version")?.user_version ?? 0;
    if (version > SCHEMA_VERSION) {
      this.#db.close();
      throw new SchemaTooNewError(
        `база ${file} версии ${version}, код знает только до ${SCHEMA_VERSION}; обнови opencode-orchestrator`,
      );
    }
    if (version === SCHEMA_VERSION) return;

    // A version above zero means the file already held data from an older release.
    if (version > 0) copyFileSync(file, `${file}.bak-v${version}`);
    for (let next = version + 1; next <= SCHEMA_VERSION; next++) {
      this.transaction(() => {
        this.#db.exec(MIGRATIONS[next] ?? "");
        this.#db.exec(`PRAGMA user_version = ${next}`);
      });
    }
  }

  #get<Schema extends z.ZodType>(
    schema: Schema,
    sql: string,
    ...params: SQLInputValue[]
  ): z.infer<Schema> | undefined {
    const row = this.#db.prepare(sql).get(...params);
    return row === undefined ? undefined : schema.parse(row);
  }

  #all<Schema extends z.ZodType>(
    schema: Schema,
    sql: string,
    ...params: SQLInputValue[]
  ): z.infer<Schema>[] {
    return this.#db
      .prepare(sql)
      .all(...params)
      .map((row) => schema.parse(row));
  }

  close(): void {
    this.#db.close();
  }

  transaction<Value>(work: () => Value): Value {
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

  /** Reads every stored task once, so a broken row stops the start instead of a later tick. */
  verifyTasks(): void {
    this.tasks();
  }

  salt(): string {
    const row = this.#get(ValueRow, "SELECT value FROM meta WHERE key = 'salt'");
    if (row) return row.value;

    const salt = randomBytes(16).toString("hex");
    this.#db.prepare("INSERT INTO meta (key, value) VALUES ('salt', ?)").run(salt);
    return salt;
  }

  insertTask(state: TaskState, now: number): void {
    const seq = this.#get(NextSeqRow, "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM tasks")?.seq;
    this.#db
      .prepare(
        "INSERT INTO tasks (id, seq, status, state, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
      )
      .run(state.id, seq ?? 1, state.status, JSON.stringify(state), now, now);
  }

  saveTask(state: TaskState, now: number): void {
    this.#db
      .prepare(
        "UPDATE tasks SET status = ?, state = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      )
      .run(state.status, JSON.stringify(state), now, state.id);
  }

  task(id: string): TaskState | undefined {
    const row = this.#get(TaskRow, "SELECT id, state FROM tasks WHERE id = ?", id);
    return row ? parseTaskState(row) : undefined;
  }

  tasks(): TaskState[] {
    return this.#all(TaskRow, "SELECT id, state FROM tasks ORDER BY seq").map(parseTaskState);
  }

  addIntents(taskID: string, intents: readonly Intent[], now: number): void {
    const insert = this.#db.prepare(
      "INSERT INTO intents (task_id, kind, payload, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
    );
    for (const intent of intents) insert.run(taskID, intent.kind, JSON.stringify(intent), now);
  }

  cancelPendingIntents(taskID: string): void {
    this.#db
      .prepare("UPDATE intents SET status = 'cancelled' WHERE task_id = ? AND status = 'pending'")
      .run(taskID);
  }

  /** The oldest pending intent of every task: intents of one task run strictly in order. */
  headIntents(): StoredIntent[] {
    const rows = this.#all(
      IntentRow,
      `SELECT i.id, i.task_id, i.payload, i.attempts, i.next_at FROM intents i
       WHERE i.status = 'pending' AND i.id = (
         SELECT MIN(j.id) FROM intents j WHERE j.task_id = i.task_id AND j.status = 'pending')
       ORDER BY i.id`,
    );
    return rows.map((row) => ({
      id: row.id,
      taskID: row.task_id,
      // Intents are written and read by the same release, and a changed shape bumps SCHEMA_VERSION.
      intent: JSON.parse(row.payload) as Intent,
      attempts: row.attempts,
      nextAt: row.next_at,
    }));
  }

  isIntentPending(id: number): boolean {
    return (
      this.#get(StatusRow, "SELECT status FROM intents WHERE id = ?", id)?.status === "pending"
    );
  }

  finishIntent(id: number, status: "done" | "failed", error?: string): void {
    this.#db
      .prepare("UPDATE intents SET status = ?, last_error = ? WHERE id = ?")
      .run(status, error ?? null, id);
  }

  deferIntent(id: number, nextAt: number, error: string): void {
    this.#db
      .prepare(
        "UPDATE intents SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE id = ?",
      )
      .run(nextAt, error, id);
  }

  command(id: string): StoredCommand | undefined {
    const row = this.#get(CommandRow, "SELECT request, result FROM commands WHERE id = ?", id);
    return row ? { request: row.request, result: JSON.parse(row.result) } : undefined;
  }

  saveCommand(input: {
    id: string;
    method: string;
    request: string;
    result: unknown;
    now: number;
  }): void {
    this.#db
      .prepare(
        "INSERT INTO commands (id, method, request, result, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(input.id, input.method, input.request, JSON.stringify(input.result), input.now);
  }

  countIntents(): Record<string, number> {
    const rows = this.#all(
      CountRow,
      "SELECT status, COUNT(*) AS count FROM intents GROUP BY status",
    );
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }
}

function parseTaskState(row: { id: string; state: string }): TaskState {
  let raw: unknown;
  try {
    raw = JSON.parse(row.state);
  } catch {
    throw new CorruptStateError(`задача ${row.id}: состояние не является JSON`);
  }

  const parsed = TaskStateSchema.safeParse(raw);
  if (!parsed.success)
    throw new CorruptStateError(`задача ${row.id}: ${describeIssue(parsed.error)}`);
  return parsed.data;
}
