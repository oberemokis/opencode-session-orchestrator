import { decide } from "./core/decide.js";
import type { Result } from "./core/result.js";
import {
  type TaskEvent,
  type TaskState,
  type TaskStatus,
  TERMINAL_STATUSES,
} from "./core/types.js";
import { executeIntent } from "./executor.js";
import type { OpenCodeClient } from "./opencode.js";
import { PermanentError } from "./permanent-error.js";
import { SessionWatcher } from "./session-watcher.js";
import type { Store, StoredIntent } from "./store.js";

export interface EngineOptions {
  readonly store: Store;
  readonly opencode: OpenCodeClient;
  readonly slots: number;
  readonly tickMs: number;
  readonly retryBaseMs: number;
  readonly maxIntentAttempts: number;
  /** Length of one stall "minute"; tests shorten it. */
  readonly stallUnitMs: number;
  readonly log: (line: string) => void;
}

export type ApplyOutcome = Result<{ readonly state: TaskState }>;

export interface CommandRecord {
  readonly id: string;
  readonly method: string;
  readonly request: string;
  readonly result: (outcome: ApplyOutcome) => unknown;
}

const SLOT_STATUSES = new Set<TaskStatus>(["active", "waiting", "blocked"]);
const MAX_RETRY_DELAY_MS = 30_000;

export class Engine {
  readonly #options: EngineOptions;
  readonly #watcher: SessionWatcher;
  readonly #running = new Set<string>();
  #queue: Promise<unknown> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #inflight = new Set<Promise<unknown>>();

  constructor(options: EngineOptions) {
    this.#options = options;
    this.#watcher = new SessionWatcher({
      store: options.store,
      opencode: options.opencode,
      stallUnitMs: options.stallUnitMs,
      log: options.log,
      report: (taskID, event) => this.apply(taskID, event),
    });
  }

  get store(): Store {
    return this.#options.store;
  }

  start(): void {
    this.#watcher.restartClocks();
    void this.serial(() => this.#schedule());
    this.#pump();
    void this.reconcile();
    this.#timer = setInterval(() => {
      this.#pump();
      void this.reconcile();
    }, this.#options.tickMs);
  }

  /** Stops loops. In-flight work is abandoned, as after kill -9; durable state stays consistent. */
  halt(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
  }

  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
    await this.#queue;
  }

  /** Runs state changes one at a time, so decisions never interleave. */
  serial<Value>(work: () => Value | Promise<Value>): Promise<Value> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Applies one event inside a transaction together with its intents and the command record. */
  apply(taskID: string, event: TaskEvent, command?: CommandRecord): Promise<ApplyOutcome> {
    return this.serial(() => {
      const outcome = this.#applyNow(taskID, event, command);
      this.#afterChange();
      return outcome;
    });
  }

  /** Reads worker sessions and turns finished turns, missing reports and stalls into events. */
  async reconcile(): Promise<void> {
    if (this.#stopped) return;
    await this.#watcher.check();
  }

  /**
   * Runs a command once per commandID: a repeat returns the stored result,
   * a different request under the same commandID is refused.
   */
  runCommand(
    command: CommandRecord,
    target: { taskID: string; event: TaskEvent } | { error: string },
  ): Promise<unknown> {
    return this.serial(() => {
      const existing = this.store.command(command.id);
      if (existing) {
        return existing.request === command.request
          ? existing.result
          : { ok: false, error: `commandID ${command.id} уже использован с другим запросом` };
      }

      if ("error" in target) {
        const result = command.result({ ok: false, error: target.error });
        this.#record(command, result, Date.now());
        return result;
      }

      const outcome = this.#applyNow(target.taskID, target.event, command);
      this.#afterChange();
      return command.result(outcome);
    });
  }

  /** Creates a task row and its command record atomically, then lets the scheduler see it. */
  insertTask(state: TaskState, command: CommandRecord): Promise<unknown> {
    return this.serial(() => {
      const existing = this.store.command(command.id);
      if (existing) return existing.result;

      const result = command.result({ ok: true, state });
      const now = Date.now();
      this.store.transaction(() => {
        this.store.insertTask(state, now);
        this.#record(command, result, now);
      });
      this.#options.log(`${state.id}: принята (${state.workflow.id})`);
      this.#afterChange();
      return result;
    });
  }

  /** Must run inside serial(). */
  #applyNow(taskID: string, event: TaskEvent, command?: CommandRecord): ApplyOutcome {
    if (this.#stopped) return { ok: false, error: "runtime остановлен" };
    const state = this.store.task(taskID);
    if (!state) return { ok: false, error: `задачи ${taskID} нет` };

    const decision = decide(state, event);
    const now = Date.now();
    const outcome: ApplyOutcome = decision.ok ? { ok: true, state: decision.state } : decision;

    this.store.transaction(() => {
      if (decision.ok) {
        const leaving =
          decision.state.status === "blocked" || TERMINAL_STATUSES.includes(decision.state.status);
        if (leaving) this.store.cancelPendingIntents(taskID);
        this.store.saveTask(decision.state, now);
        this.store.addIntents(taskID, decision.intents, now);
      }
      if (command) this.#record(command, command.result(outcome), now);
    });

    if (!decision.ok) this.#options.log(`${taskID}: ${event.type} отклонено: ${decision.error}`);
    else {
      const kinds = decision.intents.map((intent) => intent.kind).join(", ");
      this.#options.log(`${taskID}: ${event.type} -> ${decision.state.status} [${kinds}]`);
    }
    return outcome;
  }

  #record(command: CommandRecord, result: unknown, now: number): void {
    this.store.saveCommand({
      id: command.id,
      method: command.method,
      request: command.request,
      result,
      now,
    });
  }

  /** Grants free slots and wakes the intent loop after a state change. Must run inside serial(). */
  #afterChange(): void {
    this.#schedule();
    queueMicrotask(() => this.#pump());
  }

  /** Grants free slots to the oldest queued tasks. Must run inside serial(). */
  #schedule(): void {
    if (this.#stopped) return;
    const tasks = this.store.tasks();
    let busy = tasks.filter((task) => SLOT_STATUSES.has(task.status)).length;

    for (const task of tasks) {
      if (busy >= this.#options.slots) break;
      if (task.status !== "queued") continue;
      if (this.#applyNow(task.id, { type: "slot-granted" }).ok) busy++;
    }
  }

  #pump(): void {
    if (this.#stopped) return;

    const now = Date.now();
    for (const head of this.store.headIntents()) {
      if (this.#running.has(head.taskID) || head.nextAt > now) continue;
      this.#running.add(head.taskID);
      this.#track(
        this.#runIntent(head).finally(() => {
          this.#running.delete(head.taskID);
          this.#pump();
        }),
      );
    }
  }

  #track(promise: Promise<unknown>): void {
    this.#inflight.add(promise);
    void promise.finally(() => this.#inflight.delete(promise));
  }

  async #runIntent(head: StoredIntent): Promise<void> {
    const task = this.store.task(head.taskID);
    if (!task) return;

    let event: TaskEvent | undefined;
    try {
      event = await executeIntent(head.intent, { opencode: this.#options.opencode, task });
    } catch (error) {
      if (this.#stopped) return;
      await this.#failIntent(head, error);
      return;
    }
    if (this.#stopped) return;

    await this.serial(() => {
      if (this.store.isIntentPending(head.id)) this.store.finishIntent(head.id, "done");
    });
    if (event) await this.apply(head.taskID, event);
  }

  async #failIntent(head: StoredIntent, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = head.attempts + 1;
    const permanent = error instanceof PermanentError;
    this.#options.log(`${head.taskID}: ${head.intent.kind} попытка ${attempts}: ${message}`);

    if (!permanent && attempts < this.#options.maxIntentAttempts) {
      const delay = Math.min(this.#options.retryBaseMs * 2 ** (attempts - 1), MAX_RETRY_DELAY_MS);
      await this.serial(() => this.store.deferIntent(head.id, Date.now() + delay, message));
      setTimeout(() => this.#pump(), delay + 5).unref();
      return;
    }

    const stillPending = await this.serial(() => {
      const pending = this.store.isIntentPending(head.id);
      if (pending) this.store.finishIntent(head.id, "failed", message);
      return pending;
    });
    if (stillPending) {
      await this.apply(head.taskID, {
        type: "intent-failed",
        intent: head.intent.kind,
        error: message,
      });
    }
  }
}
