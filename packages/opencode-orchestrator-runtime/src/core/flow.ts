import { deriveId } from "./ids.js";
import {
  assertNever,
  buildCodePrompt,
  buildCommitMessage,
  describeFinish,
  describeQuestion,
} from "./messages.js";
import type { EscalateChoice, Intent, Question, Step, TaskState } from "./types.js";
import { type Action, type Outcome, type Stage, stageRetries } from "./workflow.js";

type GotoAction = Extract<Action, { kind: "goto" | "goto-previous-code" }>;

export interface ActionContext {
  readonly reason: string;
  readonly feedback: string | null;
  /** Automatic transitions spend the retry budget; a human choice does not. */
  readonly origin: "automatic" | "human";
}

export function currentStage(state: TaskState): Stage {
  const stage = state.workflow.stages[state.stageIndex];
  if (!stage) throw new Error(`stage index ${state.stageIndex} is outside the workflow`);
  return stage;
}

export function enterStage(state: TaskState, index: number, feedback: string | null): Step {
  const stage = state.workflow.stages[index];
  if (!stage) throw new Error(`stage index ${index} is outside the workflow`);
  if (!state.sessionID) throw new Error("stage entered without a session");

  const runSeq = state.runSeq + 1;
  const runID = `${state.id}-r${runSeq}`;
  const base = { ...state, status: "active" as const, stageIndex: index, runSeq, question: null };

  switch (stage.uses) {
    case "code": {
      const run = { id: runID, stageID: stage.id, phase: "working" as const, feedback };
      const next = { ...base, run };
      const intents: Intent[] = [];
      if (stage.model)
        intents.push({ kind: "switch-model", sessionID: state.sessionID, model: stage.model });
      intents.push({
        kind: "send-prompt",
        sessionID: state.sessionID,
        messageID: deriveId("msg_", state.salt, runID, "prompt"),
        text: buildCodePrompt(next, stage, run),
      });
      return { state: next, intents };
    }
    case "show": {
      const run = { id: runID, stageID: stage.id, phase: "snapshot" as const, feedback };
      return {
        state: { ...base, run },
        intents: [{ kind: "snapshot-tree", path: state.worktreePath, stageRunID: runID }],
      };
    }
    case "deliver": {
      const run = { id: runID, stageID: stage.id, phase: "committing" as const, feedback };
      const next = { ...base, run };
      if (!state.reviewedTree || state.reviewedTree !== state.tree) {
        return escalate(next, "дифф для доставки не одобрен в show по текущему дереву");
      }
      return {
        state: next,
        intents: [
          {
            kind: "commit",
            path: state.worktreePath,
            base: state.baseCommit,
            tree: state.reviewedTree,
            message: buildCommitMessage(state),
            stageRunID: runID,
          },
        ],
      };
    }
  }
}

export function resolveAction(stage: Stage, outcome: Outcome): Action {
  const configured = stage.on?.[outcome];
  if (configured) return configured;
  if (outcome === "passed") return { kind: "next" };
  if (outcome === "changes-requested") return { kind: "goto-previous-code" };
  return { kind: "escalate" };
}

export function performAction(state: TaskState, action: Action, context: ActionContext): Step {
  const index = state.stageIndex;

  switch (action.kind) {
    case "next":
      if (index + 1 >= state.workflow.stages.length) return finish(state, "done");
      return enterStage(state, index + 1, null);

    case "stop":
      return finish(state, "stopped");

    case "escalate":
      return escalate(state, context.reason);

    case "repeat":
      return reenter(state, index, context);

    case "goto":
    case "goto-previous-code": {
      const targetIndex = findTarget(state, action);
      if (targetIndex === undefined) {
        return escalate(state, `переход ${describeGoto(action)} некуда выполнить`);
      }
      return reenter(state, targetIndex, context);
    }

    default:
      return assertNever(action);
  }
}

function findTarget(state: TaskState, action: GotoAction): number | undefined {
  if (action.kind === "goto-previous-code") {
    for (let index = state.stageIndex - 1; index >= 0; index--) {
      if (state.workflow.stages[index]?.uses === "code") return index;
    }
    return undefined;
  }

  const index = state.workflow.stages.findIndex((stage) => stage.id === action.stageID);
  return index === -1 ? undefined : index;
}

function describeGoto(action: GotoAction): string {
  return action.kind === "goto" ? `goto:${action.stageID}` : "goto:<previous-code>";
}

function reenter(state: TaskState, targetIndex: number, context: ActionContext): Step {
  const isBackward = targetIndex <= state.stageIndex;
  if (context.origin === "human" || !isBackward)
    return enterStage(state, targetIndex, context.feedback);

  const target = state.workflow.stages[targetIndex];
  if (!target) return escalate(state, "этап перехода не найден");

  const used = (state.retries[target.id] ?? 0) + 1;
  if (used > stageRetries(target)) {
    return escalate(state, `исчерпаны повторы этапа «${target.id}»: ${context.reason}`);
  }
  return enterStage(
    { ...state, retries: { ...state.retries, [target.id]: used } },
    targetIndex,
    context.feedback,
  );
}

export function escalate(state: TaskState, reason: string): Step {
  const kind = state.workflow.stages[state.stageIndex]?.uses;
  const options: EscalateChoice[] =
    kind === "show" || kind === "deliver" ? ["repeat", "stop"] : ["repeat", "next", "stop"];
  return ask(state, {
    id: nextQuestionID(state),
    kind: "escalate",
    stageRunID: state.run?.id ?? null,
    reason,
    options,
  });
}

export function block(state: TaskState, reason: string): Step {
  return ask({ ...state, run: null }, { id: nextQuestionID(state), kind: "blocked", reason });
}

export function ask(state: TaskState, question: Question): Step {
  const status = question.kind === "blocked" ? ("blocked" as const) : ("waiting" as const);
  const withQuestion = {
    ...state,
    status,
    question,
    questionSeq: state.questionSeq + 1,
    run:
      state.run && question.kind !== "blocked"
        ? { ...state.run, phase: "asking" as const }
        : state.run,
  };
  const noted = note(withQuestion, describeQuestion(withQuestion, question));
  return { state: noted.state, intents: noted.intents };
}

export function finish(state: TaskState, status: "done" | "stopped"): Step {
  const finished = { ...state, status, question: null, run: null };
  const intents: Intent[] = [];

  if (status === "done") intents.push({ kind: "remove-worktree", path: state.worktreePath });
  if (status === "stopped" && state.sessionID && state.sessionReady) {
    intents.push({ kind: "abort-session", sessionID: state.sessionID });
  }

  const noted = note(finished, describeFinish(finished));
  return { state: noted.state, intents: [...intents, ...noted.intents] };
}

function note(state: TaskState, text: string): Step {
  const noteSeq = state.noteSeq + 1;
  return {
    state: { ...state, noteSeq },
    intents: [
      {
        kind: "notify-lead",
        sessionID: state.sourceSessionID,
        directory: state.sourceDirectory,
        messageID: deriveId("msg_", state.salt, state.id, `note-${noteSeq}`),
        text,
      },
    ],
  };
}

function nextQuestionID(state: TaskState): string {
  return `${state.id}-q${state.questionSeq + 1}`;
}
