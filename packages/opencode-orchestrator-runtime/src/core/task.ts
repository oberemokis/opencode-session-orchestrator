import { deriveId } from "./ids.js";
import type { ProjectConfig } from "./project-config.js";
import type { Step, TaskState } from "./types.js";
import type { Workflow } from "./workflow.js";

export interface NewTask {
  readonly id: string;
  readonly salt: string;
  readonly text: string;
  readonly sourceSessionID: string;
  readonly sourceDirectory: string;
  readonly projectDir: string;
  readonly baseCommit: string;
  readonly workflow: Workflow;
  readonly workflowHash: string;
  readonly config: ProjectConfig;
}

export function createTask(input: NewTask): TaskState {
  return {
    ...input,
    worktreePath: `${input.projectDir}/.worktrees/${input.id}`,
    branch: `${input.config.branchPrefix}/${input.id}`,
    status: "queued",
    stageIndex: 0,
    attempt: 0,
    sessionID: null,
    sessionReady: false,
    run: null,
    runSeq: 0,
    retries: {},
    tree: null,
    reviewedTree: null,
    question: null,
    questionSeq: 0,
    noteSeq: 0,
    summary: null,
  };
}

/** A new attempt keeps the worktree and branch, and gets a fresh session. */
export function startAttempt(state: TaskState): Step {
  const attempt = state.attempt + 1;
  const sessionID = deriveId("ses_", state.salt, state.id, `attempt-${attempt}`);
  const next: TaskState = {
    ...state,
    status: "active",
    attempt,
    sessionID,
    sessionReady: false,
    run: null,
    question: null,
  };

  return {
    state: next,
    intents: [
      {
        kind: "ensure-worktree",
        path: state.worktreePath,
        branch: state.branch,
        base: state.baseCommit,
      },
      {
        kind: "prepare-worktree",
        path: state.worktreePath,
        projectDir: state.projectDir,
        copy: state.config.setup.copy,
        command: state.config.setup.command ?? null,
      },
      {
        kind: "create-session",
        sessionID,
        attempt,
        directory: state.worktreePath,
        title: `orchestrator ${state.id}: ${state.text.split("\n")[0]?.slice(0, 60) ?? ""}`,
        deny: state.config.deny,
        mcpRead: state.config.mcpRead,
      },
    ],
  };
}
