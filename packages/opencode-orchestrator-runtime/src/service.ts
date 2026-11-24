import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { deriveTaskId } from "./core/ids.js";
import { type ProjectConfig, parseProjectConfig } from "./core/project-config.js";
import type { Result } from "./core/result.js";
import { createTask } from "./core/task.js";
import { isAnswerChoice, type TaskState } from "./core/types.js";
import { type ParseResult, parseWorkflow, type Workflow } from "./core/workflow.js";
import type { ApplyOutcome, Engine } from "./engine.js";
import { diffTree, projectRoot, resolveCommit } from "./git.js";
import type { QuestionView, TaskSummary } from "./rpc-contract.js";

export const WORKFLOW_FILE = ".orchestrator/workflows/default.json";
export const CONFIG_FILE = ".orchestrator/config.json";

const StartInput = z.object({
  commandID: z.string().min(1),
  text: z.string().min(1),
  sessionID: z.string().min(1),
  directory: z.string().min(1),
});
const StopInput = z.object({ commandID: z.string().min(1), taskID: z.string().min(1) });
const AnswerInput = z.object({
  commandID: z.string().min(1),
  questionID: z.string().min(1),
  choice: z.string().min(1),
  text: z.string().optional(),
  tree: z.string().optional(),
});

interface ProjectFiles {
  readonly workflow: Workflow;
  readonly workflowHash: string;
  readonly config: ProjectConfig;
}

export class Service {
  readonly #engine: Engine;

  constructor(engine: Engine) {
    this.#engine = engine;
  }

  async call(method: string, input: unknown): Promise<unknown> {
    switch (method) {
      case "task.start":
        return this.startTask(StartInput.parse(input));
      case "task.stop": {
        const { commandID, taskID } = StopInput.parse(input);
        return this.#engine.runCommand(
          record(commandID, method, input, (outcome) => toResult(outcome)),
          { taskID, event: { type: "stop-requested" } },
        );
      }
      case "question.answer":
        return this.answer(AnswerInput.parse(input));
      case "question.get":
        return this.questions();
      case "status":
        return { tasks: this.status() };
      default:
        throw new Error(`неизвестный метод ${method}`);
    }
  }

  async startTask(input: z.infer<typeof StartInput>): Promise<unknown> {
    const existing = this.#engine.store.command(input.commandID);
    if (existing) return existing.result;

    const projectDir = await projectRoot(input.directory).catch(() => undefined);
    if (!projectDir) return { ok: false, error: `${input.directory} не git-репозиторий` };

    const files = loadProjectFiles(projectDir);
    if (!files.ok) return files;

    const baseCommit = await resolveCommit(projectDir, files.config.base).catch(
      (error: Error) => error,
    );
    if (baseCommit instanceof Error) {
      return { ok: false, error: `база ${files.config.base}: ${baseCommit.message}` };
    }

    const salt = await this.#engine.serial(() => this.#engine.store.salt());
    const task = createTask({
      id: deriveTaskId(salt, input.commandID),
      salt,
      text: input.text,
      sourceSessionID: input.sessionID,
      sourceDirectory: input.directory,
      projectDir,
      baseCommit,
      workflow: files.workflow,
      workflowHash: files.workflowHash,
      config: files.config,
    });

    return this.#engine.insertTask(
      task,
      record(input.commandID, "task.start", input, () => ({
        ok: true,
        taskID: task.id,
        status: task.status,
      })),
    );
  }

  answer(input: z.infer<typeof AnswerInput>): Promise<unknown> {
    const owner = this.#engine.store.tasks().find((task) => task.question?.id === input.questionID);
    const command = record(input.commandID, "question.answer", input, (outcome) =>
      toResult(outcome),
    );
    if (!owner) return this.#engine.runCommand(command, { error: "вопрос уже закрыт" });

    const choice = input.choice;
    if (!isAnswerChoice(choice)) {
      return this.#engine.runCommand(command, { error: `вариант ${choice} не предлагался` });
    }

    return this.#engine.runCommand(command, {
      taskID: owner.id,
      event: {
        type: "answered",
        questionID: input.questionID,
        choice,
        text: input.text,
        tree: input.tree,
      },
    });
  }

  status(): TaskSummary[] {
    return this.#engine.store.tasks().map((task) => ({
      id: task.id,
      status: task.status,
      stage: task.status === "queued" ? null : (task.workflow.stages[task.stageIndex]?.id ?? null),
      text: task.text.split("\n")[0] ?? "",
      branch: task.branch,
      worktree: task.worktreePath,
      question: task.question?.kind ?? null,
    }));
  }

  async questions(): Promise<{ questions: QuestionView[] }> {
    const open = this.#engine.store
      .tasks()
      .filter(
        (task): task is TaskState & { question: NonNullable<TaskState["question"]> } =>
          task.question !== null,
      );
    const views: QuestionView[] = [];

    for (const task of open) {
      const question = task.question;
      const stage = task.workflow.stages[task.stageIndex]?.id ?? null;
      const base = {
        questionID: question.id,
        taskID: task.id,
        kind: question.kind,
        text: task.text,
        stage,
      };

      if (question.kind === "show") {
        const files = await diffTree({
          cwd: task.projectDir,
          base: task.baseCommit,
          tree: question.tree,
        }).catch(() => []);
        views.push({
          ...base,
          reason: null,
          options: ["approve", "changes-requested", "stop"],
          tree: question.tree,
          files,
        });
      } else if (question.kind === "escalate") {
        views.push({
          ...base,
          reason: question.reason,
          options: [...question.options],
          tree: null,
          files: [],
        });
      } else {
        views.push({
          ...base,
          reason: question.reason,
          options: ["retry", "stop"],
          tree: null,
          files: [],
        });
      }
    }
    return { questions: views };
  }
}

function record(
  id: string,
  method: string,
  input: unknown,
  result: (outcome: ApplyOutcome) => unknown,
) {
  return { id, method, request: JSON.stringify(input), result };
}

function toResult(outcome: ApplyOutcome): unknown {
  return outcome.ok
    ? { ok: true, taskID: outcome.state.id, status: outcome.state.status }
    : outcome;
}

/** Reads the route and the project config from the main checkout; a missing config means defaults. */
function loadProjectFiles(projectDir: string): Result<ProjectFiles> {
  const workflowPath = join(projectDir, WORKFLOW_FILE);
  if (!existsSync(workflowPath)) return { ok: false, error: `нет маршрута ${WORKFLOW_FILE}` };

  const workflow = readProjectFile(workflowPath, WORKFLOW_FILE, parseWorkflow);
  if (!workflow.ok) return workflow;

  const configPath = join(projectDir, CONFIG_FILE);
  const config = existsSync(configPath)
    ? readProjectFile(configPath, CONFIG_FILE, parseProjectConfig)
    : parseProjectConfig(undefined);
  if (!config.ok) return config;

  return {
    ok: true,
    workflow: workflow.value,
    workflowHash: workflow.hash,
    config: config.value,
  };
}

function readProjectFile<Value>(
  path: string,
  label: string,
  parse: (raw: unknown) => ParseResult<Value>,
): ParseResult<Value> {
  const json = readJson(path);
  if (!json.ok) return { ok: false, error: `${label}: ${json.error}` };

  const parsed = parse(json.value);
  return parsed.ok ? parsed : { ok: false, error: `${label}: ${parsed.error}` };
}

function readJson(path: string): Result<{ readonly value: unknown }> {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `некорректный JSON: ${reason}` };
  }
}
