import { decide } from "./core/decide.js";
import { deriveId } from "./core/ids.js";
import { type TaskEvent, type TaskState, TERMINAL_STATUSES } from "./core/types.js";
import { stageStallMinutes } from "./core/workflow.js";
import { executeIntent } from "./executor.js";
import { PermanentError } from "./git.js";
import type { OpenCodeClient } from "./opencode.js";
import { readTurn } from "./reconcile.js";
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

export interface CommandRecord {
  readonly id: string;
  readonly method: string;
  readonly request: string;
  readonly result: (decision: ApplyOutcome) => unknown;
}

const SLOT_STATUSES = new Set(["active", "waiting", "blocked"]);

export type ApplyOutcome = { ok: true; state: TaskState } | { ok: false; reject: string };

export class Engine {
  readonly #options: EngineOptions;
  readonly #running = new Set<string>();
  #queue: Promise<unknown> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #recoveredAt = Date.now();
  #opencodeDown = false;
  #inflight = new Set<Promise<unknown>>();

  constructor(options: EngineOptions) {
    this.#options = options;
  }

  get store(): Store {
    return this.#options.store;
  }

  start(): void {
    this.#recoveredAt = Date.now();
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
  serial<Result>(work: () => Result | Promise<Result>): Promise<Result> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Applies one event inside a transaction together with its intents and the command record. */
  apply(taskID: string, event: TaskEvent, command?: CommandRecord): Promise<ApplyOutcome> {
    return this.serial(() => {
      const outcome = this.#applyNow(taskID, event, command);
      this.#schedule();
      queueMicrotask(() => this.#pump());
      return outcome;
    });
  }

  /** Must run inside serial(). */
  #applyNow(taskID: string, event: TaskEvent, command?: CommandRecord): ApplyOutcome {
    if (this.#stopped) return { ok: false, reject: "runtime остановлен" };
    const state = this.store.task(taskID);
    if (!state) return { ok: false, reject: `задачи ${taskID} нет` };

    const decision = decide(state, event);
    const now = Date.now();
    const outcome: ApplyOutcome = decision.ok ? { ok: true, state: decision.state } : { ok: false, reject: decision.reject };

    this.store.transaction(() => {
      if (decision.ok) {
        const leaving = decision.state.status === "blocked" || TERMINAL_STATUSES.includes(decision.state.status);
        if (leaving) this.store.cancelPendingIntents(taskID);
        this.store.saveTask(decision.state, now);
        this.store.addIntents(taskID, decision.intents, now);
      }
      if (command)
        this.store.saveCommand({ id: command.id, method: command.method, request: command.request, result: command.result(outcome), now });
    });

    if (!decision.ok) this.#options.log(`${taskID}: ${event.type} отклонено: ${decision.reject}`);
    else
      this.#options.log(
        `${taskID}: ${event.type} -> ${decision.state.status} [${decision.intents.map((intent) => intent.kind).join(", ")}]`,
      );
    return outcome;
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

  /**
   * Runs a command once per commandID: a repeat returns the stored result,
   * a different request under the same commandID is refused.
   */
  runCommand(command: CommandRecord, target: { taskID: string; event: TaskEvent } | { reject: string }): Promise<unknown> {
    return this.serial(() => {
      const existing = this.store.command(command.id);
      if (existing) {
        return existing.request === command.request
          ? existing.result
          : { ok: false, error: `commandID ${command.id} уже использован с другим запросом` };
      }

      if ("reject" in target) {
        const result = command.result({ ok: false, reject: target.reject });
        this.store.saveCommand({ id: command.id, method: command.method, request: command.request, result, now: Date.now() });
        return result;
      }

      const outcome = this.#applyNow(target.taskID, target.event, command);
      this.#schedule();
      queueMicrotask(() => this.#pump());
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
        this.store.saveCommand({ id: command.id, method: command.method, request: command.request, result, now });
      });
      this.#options.log(`${state.id}: принята (${state.workflow.id})`);
      this.#schedule();
      queueMicrotask(() => this.#pump());
      return result;
    });
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
      const delay = Math.min(this.#options.retryBaseMs * 2 ** (attempts - 1), 30_000);
      await this.serial(() => this.store.deferIntent(head.id, Date.now() + delay, message));
      setTimeout(() => this.#pump(), delay + 5).unref();
      return;
    }

    const stillPending = await this.serial(() => {
      const pending = this.store.isIntentPending(head.id);
      if (pending) this.store.finishIntent(head.id, "failed", message);
      return pending;
    });
    if (stillPending) await this.apply(head.taskID, { type: "intent-failed", intent: head.intent.kind, error: message });
  }

  /** Reads worker sessions and turns finished turns, missing reports and stalls into events. */
  async reconcile(): Promise<void> {
    if (this.#stopped) return;

    const working = this.store.tasks().filter((task) => task.status === "active" && task.run?.phase === "working" && task.sessionReady);
    for (const task of working) {
      await this.#reconcileTask(task).catch((error: unknown) => {
        if (!this.#opencodeDown) this.#options.log(`сверка ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
        this.#opencodeDown = true;
      });
    }
  }

  async #reconcileTask(task: TaskState): Promise<void> {
    const run = task.run;
    if (!run || !task.sessionID) return;

    const session = await this.#options.opencode.session(task.sessionID, task.worktreePath);
    const messages = await this.#options.opencode.messages(task.sessionID, task.worktreePath);
    if (this.#opencodeDown) {
      // Downtime does not count as a stall: the clock restarts when OpenCode answers again.
      this.#opencodeDown = false;
      this.#recoveredAt = Date.now();
    }
    if (!session || !messages) return;

    const reading = readTurn(messages, deriveId("msg_", task.salt, run.id, "prompt"), run.id);
    if (reading.kind === "ended") {
      const event: TaskEvent = reading.report
        ? { type: "stage-reported", stageRunID: run.id, outcome: reading.report.outcome, summary: reading.report.summary }
        : { type: "turn-ended-without-report", stageRunID: run.id, detail: reading.detail };
      await this.apply(task.id, event);
      return;
    }
    if (reading.kind === "not-delivered") return;

    const stage = task.workflow.stages[task.stageIndex];
    const lastActivity = Math.max(session.time.updated, this.#recoveredAt);
    if (stage && Date.now() - lastActivity > stageStallMinutes(stage) * this.#options.stallUnitMs) {
      await this.apply(task.id, { type: "stalled", stageRunID: run.id });
    }
  }
}
