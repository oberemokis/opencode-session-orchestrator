import type { Question, StageRun, TaskState } from "./types.js";
import type { Stage } from "./workflow.js";

export function buildCodePrompt(task: TaskState, stage: Stage, run: StageRun): string {
  const parts = [`Задача оркестратора ${task.id}, этап «${stage.id}».`, "", task.text];

  if (stage.instructions) parts.push("", `Инструкции этапа: ${stage.instructions}`);
  if (run.feedback) parts.push("", "Замечания к предыдущему проходу:", run.feedback);

  parts.push(
    "",
    "Работай только в текущем каталоге, это отдельный git worktree задачи.",
    "Не делай коммитов, push и merge: коммит сделает оркестратор после того, как человек одобрит дифф.",
    `Когда закончишь, вызови инструмент stage_report один раз: stageRunID "${run.id}", outcome "passed", если работа сделана, или "stuck", если продолжить не можешь; в summary коротко опиши, что сделано или что мешает.`,
  );
  return parts.join("\n");
}

export function buildCommitMessage(task: TaskState): string {
  const firstLine = task.text.split("\n")[0]?.trim() ?? "";
  const title = firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine;
  return `${title || `Task ${task.id}`}\n\nOrchestrator-Task: ${task.id}`;
}

export function describeQuestion(task: TaskState, question: Question): string {
  switch (question.kind) {
    case "show":
      return `[оркестратор] Задача ${task.id} ждёт просмотра диффа в панели TUI.`;
    case "escalate":
      return `[оркестратор] Задача ${task.id} ждёт решения в панели TUI: ${question.reason}`;
    case "blocked":
      return `[оркестратор] Задача ${task.id} заблокирована: ${question.reason}. Новая попытка или стоп выбираются в панели TUI.`;
    default:
      return assertNever(question);
  }
}

export function describeFinish(task: TaskState): string {
  if (task.status === "done") {
    return `[оркестратор] Задача ${task.id} готова: коммит в ветке ${task.branch}.`;
  }
  return `[оркестратор] Задача ${task.id} остановлена. Worktree ${task.worktreePath} оставлен для разбора.`;
}

export function assertNever(value: never): never {
  throw new Error(`неожиданный вариант: ${JSON.stringify(value)}`);
}
