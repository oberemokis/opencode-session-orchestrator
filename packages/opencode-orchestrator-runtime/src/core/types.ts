import type { ProjectConfig } from "./project-config.js";
import type { ModelRef, Workflow } from "./workflow.js";

export type TaskStatus = "queued" | "active" | "waiting" | "blocked" | "done" | "stopped";

export const TERMINAL_STATUSES: readonly TaskStatus[] = ["done", "stopped"];

export type RunPhase = "working" | "snapshot" | "asking" | "committing";

export interface StageRun {
  readonly id: string;
  readonly stageID: string;
  readonly phase: RunPhase;
  readonly feedback: string | null;
}

export type ShowChoice = "approve" | "changes-requested" | "stop";
export type EscalateChoice = "repeat" | "next" | "stop";
export type BlockedChoice = "retry" | "stop";

export type Question =
  | { readonly id: string; readonly kind: "show"; readonly stageRunID: string; readonly tree: string }
  | {
      readonly id: string;
      readonly kind: "escalate";
      readonly stageRunID: string | null;
      readonly reason: string;
      readonly options: readonly EscalateChoice[];
    }
  | { readonly id: string; readonly kind: "blocked"; readonly reason: string };

export interface TaskState {
  readonly id: string;
  readonly salt: string;
  readonly text: string;
  readonly sourceSessionID: string;
  readonly sourceDirectory: string;
  readonly projectDir: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly workflow: Workflow;
  readonly workflowHash: string;
  readonly config: ProjectConfig;
  readonly status: TaskStatus;
  readonly stageIndex: number;
  readonly attempt: number;
  readonly sessionID: string | null;
  readonly sessionReady: boolean;
  readonly run: StageRun | null;
  readonly runSeq: number;
  readonly retries: Readonly<Record<string, number>>;
  readonly tree: string | null;
  readonly reviewedTree: string | null;
  readonly question: Question | null;
  readonly questionSeq: number;
  readonly noteSeq: number;
  readonly summary: string | null;
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
  | { readonly type: "turn-ended-without-report"; readonly stageRunID: string; readonly detail: string }
  | { readonly type: "stalled"; readonly stageRunID: string }
  | { readonly type: "tree-snapshotted"; readonly stageRunID: string; readonly tree: string }
  | {
      readonly type: "answered";
      readonly questionID: string;
      readonly choice: string;
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
  | { readonly kind: "ensure-worktree"; readonly path: string; readonly branch: string; readonly base: string }
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
  | { readonly kind: "send-prompt"; readonly sessionID: string; readonly messageID: string; readonly text: string }
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

export type Decision =
  | { readonly ok: true; readonly state: TaskState; readonly intents: readonly Intent[] }
  | { readonly ok: false; readonly reject: string };
