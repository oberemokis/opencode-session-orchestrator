import { type ActionContext, ask, block, currentStage, enterStage, finish, performAction, resolveAction, type Step } from "./flow.js";
import { assertNever } from "./messages.js";
import { startAttempt } from "./task.js";
import { type Decision, type Question, type TaskEvent, type TaskState, TERMINAL_STATUSES } from "./types.js";

/** Intents whose failure must not block the task: they only tidy up or inform. */
const NON_BLOCKING_INTENTS = new Set(["notify-lead", "remove-worktree", "abort-session"]);

export function decide(state: TaskState, event: TaskEvent): Decision {
  if (TERMINAL_STATUSES.includes(state.status)) {
    return reject(`задача ${state.id} уже завершена (${state.status})`);
  }

  switch (event.type) {
    case "slot-granted":
      if (state.status !== "queued") return reject("место выдаётся только задаче в очереди");
      return accept(startAttempt(state));

    case "session-confirmed":
      if (event.attempt !== state.attempt || state.sessionReady) return reject("подтверждение чужой попытки");
      return accept(enterStage({ ...state, sessionReady: true }, state.stageIndex, state.run?.feedback ?? null));

    case "session-collision":
      if (event.attempt !== state.attempt) return reject("коллизия чужой попытки");
      return accept(block(state, `сессия ${state.sessionID} уже существует и принадлежит не этой задаче: ${event.detail}`));

    case "stage-reported":
    case "turn-ended-without-report":
    case "stalled":
      return onWorkerResult(state, event);

    case "tree-snapshotted": {
      if (state.run?.id !== event.stageRunID || state.run.phase !== "snapshot") return reject("снимок чужого прохода");
      const question: Question = { id: `${state.id}-q${state.questionSeq + 1}`, kind: "show", stageRunID: state.run.id, tree: event.tree };
      return accept(ask({ ...state, tree: event.tree }, question));
    }

    case "answered":
      return onAnswer(state, event);

    case "commit-result": {
      if (state.run?.id !== event.stageRunID || state.run.phase !== "committing") return reject("результат чужого коммита");
      if (event.kind === "ok") return accept(outcome(state, "passed", { reason: "коммит создан", feedback: null, origin: "automatic" }));

      const reason =
        event.kind === "hook-rejected"
          ? "pre-commit хук отклонил коммит"
          : "хук изменил файлы при коммите, коммит откачен, правки хука остались в worktree";
      const feedback = event.output ? `${reason}. Вывод:\n${event.output}` : reason;
      return accept(outcome(state, "failed", { reason, feedback, origin: "automatic" }));
    }

    case "intent-failed":
      if (NON_BLOCKING_INTENTS.has(event.intent)) return accept({ state, intents: [] });
      return accept(block(state, `${event.intent}: ${event.error}`));

    case "stop-requested":
      return accept(finish(state, "stopped"));

    default:
      return assertNever(event);
  }
}

function onWorkerResult(
  state: TaskState,
  event: Extract<TaskEvent, { type: "stage-reported" | "turn-ended-without-report" | "stalled" }>,
): Decision {
  if (state.run?.id !== event.stageRunID || state.run.phase !== "working") return reject("отчёт чужого прохода");

  if (event.type === "stage-reported") {
    const reason = event.outcome === "passed" ? "этап пройден" : `исполнитель застрял: ${event.summary}`;
    const feedback = event.outcome === "passed" ? null : `Прошлый проход закончился исходом stuck: ${event.summary}`;
    return accept(outcome({ ...state, summary: event.summary }, event.outcome, { reason, feedback, origin: "automatic" }));
  }

  if (event.type === "turn-ended-without-report") {
    const reason = `ход закончился без stage_report (${event.detail})`;
    return accept(outcome(state, "stuck", { reason, feedback: `Прошлый проход ${reason}.`, origin: "automatic" }));
  }

  const reason = "исполнитель не отвечает дольше лимита простоя";
  const step = outcome(state, "stalled", { reason, feedback: `Прошлый проход прерван: ${reason}.`, origin: "automatic" });
  const abort = state.sessionID ? [{ kind: "abort-session" as const, sessionID: state.sessionID }] : [];
  return accept({ state: step.state, intents: [...abort, ...step.intents] });
}

function onAnswer(state: TaskState, event: Extract<TaskEvent, { type: "answered" }>): Decision {
  const question = state.question;
  if (!question || question.id !== event.questionID) return reject("вопрос уже закрыт");

  const cleared = { ...state, question: null };
  const human = (reason: string, feedback: string | null): ActionContext => ({ reason, feedback, origin: "human" });

  switch (question.kind) {
    case "show": {
      if (event.tree !== question.tree) return reject("дерево в ответе не совпадает с показанным");
      if (event.choice === "approve") {
        return accept(
          performAction(
            { ...cleared, reviewedTree: question.tree },
            resolveAction(currentStage(state), "passed"),
            human("дифф одобрен", null),
          ),
        );
      }
      if (event.choice === "changes-requested") {
        const text = event.text?.trim();
        if (!text) return reject("для «нужны правки» нужен текст");
        const action = resolveAction(currentStage(state), "changes-requested");
        return accept(performAction(cleared, action, human("человек попросил правки", `Человек попросил правки:\n${text}`)));
      }
      if (event.choice === "stop") return accept(finish(cleared, "stopped"));
      return reject(`вариант ${event.choice} не предлагался`);
    }

    case "escalate": {
      if (!(question.options as readonly string[]).includes(event.choice)) return reject(`вариант ${event.choice} не предлагался`);
      if (event.choice === "stop") return accept(finish(cleared, "stopped"));
      if (event.choice === "next") return accept(performAction(cleared, "next", human("человек выбрал продолжить", null)));
      const feedback = event.text?.trim() ? `Комментарий человека:\n${event.text.trim()}` : (state.run?.feedback ?? null);
      return accept(enterStage(cleared, state.stageIndex, feedback));
    }

    case "blocked":
      if (event.choice === "stop") return accept(finish(cleared, "stopped"));
      if (event.choice === "retry") return accept(startAttempt(cleared));
      return reject(`вариант ${event.choice} не предлагался`);

    default:
      return assertNever(question);
  }
}

function outcome(state: TaskState, name: string, context: ActionContext): Step {
  return performAction(state, resolveAction(currentStage(state), name), context);
}

function accept(step: Step): Decision {
  return { ok: true, state: step.state, intents: step.intents };
}

function reject(reason: string): Decision {
  return { ok: false, reject: reason };
}
