import type { z } from "zod";
import type { Result } from "./result.js";
import type { TaskStateSchema } from "./task-state.js";
import type { ModelRef } from "./workflow.js";

export type TaskState = z.infer<typeof TaskStateSchema>;
export type TaskStatus = TaskState["status"];
export type StageRun = NonNullable<TaskState["run"]>;
export type RunPhase = StageRun["phase"];
export type Question = NonNullable<TaskState["question"]>;

export const TERMINAL_STATUSES: readonly TaskStatus[] = ["done", "stopped"];

export type ShowChoice = "approve" | "changes-requested" | "stop";
export type EscalateChoice = "repeat" | "next" | "stop";
export type BlockedChoice = "retry" | "stop";
export type AnswerChoice = ShowChoice | EscalateChoice | BlockedChoice;

export const ANSWER_CHOICES = [
  "approve",
  "changes-requested",
  "stop",
  "repeat",
  "next",
  "retry",
] as const satisfies readonly AnswerChoice[];

export function isAnswerChoice(value: string): value is AnswerChoice {
  return ANSWER_CHOICES.some((choice) => choice === value);
}

export type CommitResultKind = "ok" | "hook-rejected" | "tree-mismatch";

export type TaskEvent =
  | { readonly type: "slot-granted" }
  | { readonly type: "session-confirmed"; readonly attempt: number }
  | { readonly type: "session-collision"; readonly attempt: number; readonly detail: string }
  | {
      readonly type: "stage-reported";
      readonly stageRunID: string;
      readonly outcome: "passed" | "stuck";
      readonly summary: string;
    }
  | {
      readonly type: "turn-ended-without-report";
      readonly stageRunID: string;
      readonly detail: string;
    }
  | { readonly type: "stalled"; readonly stageRunID: string }
  | { readonly type: "tree-snapshotted"; readonly stageRunID: string; readonly tree: string }
  | {
      readonly type: "answered";
      readonly questionID: string;
      readonly choice: AnswerChoice;
      readonly text?: string | undefined;
      readonly tree?: string | undefined;
    }
  | {
      readonly type: "commit-result";
      readonly stageRunID: string;
      readonly kind: CommitResultKind;
      readonly output?: string | undefined;
    }
  | { readonly type: "intent-failed"; readonly intent: IntentKind; readonly error: string }
  | { readonly type: "stop-requested" };

export type Intent =
  | {
      readonly kind: "ensure-worktree";
      readonly path: string;
      readonly branch: string;
      readonly base: string;
    }
  | {
      readonly kind: "prepare-worktree";
      readonly path: string;
      readonly projectDir: string;
      readonly copy: readonly string[];
      readonly command: string | null;
    }
  | {
      readonly kind: "create-session";
      readonly sessionID: string;
      readonly attempt: number;
      readonly directory: string;
      readonly title: string;
      readonly deny: readonly string[];
      readonly mcpRead: readonly string[];
    }
  | { readonly kind: "switch-model"; readonly sessionID: string; readonly model: ModelRef }
  | {
      readonly kind: "send-prompt";
      readonly sessionID: string;
      readonly messageID: string;
      readonly text: string;
    }
  | { readonly kind: "snapshot-tree"; readonly path: string; readonly stageRunID: string }
  | {
      readonly kind: "notify-lead";
      readonly sessionID: string;
      readonly directory: string;
      readonly messageID: string;
      readonly text: string;
    }
  | {
      readonly kind: "commit";
      readonly path: string;
      readonly base: string;
      readonly tree: string;
      readonly message: string;
      readonly stageRunID: string;
    }
  | { readonly kind: "remove-worktree"; readonly path: string }
  | { readonly kind: "abort-session"; readonly sessionID: string };

export type IntentKind = Intent["kind"];

/** One transition: the next state and the side effects it asks for. */
export interface Step {
  readonly state: TaskState;
  readonly intents: readonly Intent[];
}

export type Decision = Result<Step>;
