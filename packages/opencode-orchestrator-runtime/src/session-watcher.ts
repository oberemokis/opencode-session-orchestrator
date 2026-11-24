import { deriveId } from "./core/ids.js";
import type { TaskEvent, TaskState } from "./core/types.js";
import { stageStallMinutes } from "./core/workflow.js";
import type { OpenCodeClient } from "./opencode.js";
import { readTurn } from "./reconcile.js";
import type { Store } from "./store.js";

export interface SessionWatcherOptions {
  readonly store: Store;
  readonly opencode: OpenCodeClient;
  /** Length of one stall "minute"; tests shorten it. */
  readonly stallUnitMs: number;
  readonly log: (line: string) => void;
  /** Hands an event to the engine, which decides what it means for the task. */
  readonly report: (taskID: string, event: TaskEvent) => Promise<unknown>;
}

/** Reads worker sessions and turns finished turns, missing reports and stalls into events. */
export class SessionWatcher {
  readonly #options: SessionWatcherOptions;
  #recoveredAt = Date.now();
  #opencodeDown = false;

  constructor(options: SessionWatcherOptions) {
    this.#options = options;
  }

  /** Time the runtime or OpenCode was down is not the worker's idleness: stall clocks restart now. */
  restartClocks(): void {
    this.#recoveredAt = Date.now();
  }

  async check(): Promise<void> {
    const working = this.#options.store
      .tasks()
      .filter(
        (task) => task.status === "active" && task.run?.phase === "working" && task.sessionReady,
      );

    for (const task of working) {
      await this.#checkTask(task).catch((error: unknown) => {
        if (!this.#opencodeDown) {
          const reason = error instanceof Error ? error.message : String(error);
          this.#options.log(`сверка ${task.id}: ${reason}`);
        }
        this.#opencodeDown = true;
      });
    }
  }

  async #checkTask(task: TaskState): Promise<void> {
    const run = task.run;
    if (!run || !task.sessionID) return;

    const { opencode, report, stallUnitMs } = this.#options;
    const session = await opencode.session(task.sessionID, task.worktreePath);
    const messages = await opencode.messages(task.sessionID, task.worktreePath);
    if (this.#opencodeDown) {
      // Downtime does not count as a stall: the clock restarts when OpenCode answers again.
      this.#opencodeDown = false;
      this.restartClocks();
    }
    if (!session || !messages) return;

    const reading = readTurn(messages, deriveId("msg_", task.salt, run.id, "prompt"), run.id);
    if (reading.kind === "ended") {
      const event: TaskEvent = reading.report
        ? {
            type: "stage-reported",
            stageRunID: run.id,
            outcome: reading.report.outcome,
            summary: reading.report.summary,
          }
        : { type: "turn-ended-without-report", stageRunID: run.id, detail: reading.detail };
      await report(task.id, event);
      return;
    }
    if (reading.kind === "not-delivered") return;

    const stage = task.workflow.stages[task.stageIndex];
    const lastActivity = Math.max(session.time.updated, this.#recoveredAt);
    if (stage && Date.now() - lastActivity > stageStallMinutes(stage) * stallUnitMs) {
      await report(task.id, { type: "stalled", stageRunID: run.id });
    }
  }
}
