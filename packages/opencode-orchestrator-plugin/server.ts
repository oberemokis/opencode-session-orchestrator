import { randomUUID } from "node:crypto";
import { Plugin } from "@opencode/plugin";
import {
  callRuntime,
  defaultStateDir,
  RuntimeUnavailableError,
  socketPath,
} from "opencode-orchestrator-runtime/rpc-client";
import {
  CommandReplySchema,
  QuestionsReplySchema,
  StatusReplySchema,
  type TaskSummary,
} from "opencode-orchestrator-runtime/rpc-contract";
import { ensureRuntime } from "opencode-orchestrator-runtime/spawn-runtime";
import { z } from "zod";
import { orchestratorRpc } from "./rpc.ts";

const WORKER_AGENT = "orchestrator-worker";
const NOT_RUNNING =
  "[оркестратор] runtime не запущен. Запусти в терминале: opencode-orchestrator serve";

const stateDir = defaultStateDir();
const socket = socketPath(stateDir);

/** The runtime was not listening and could not be started; the message says why. */
class RuntimeNotStartedError extends Error {}

function runtime<Schema extends z.ZodType>(
  method: string,
  schema: Schema,
  input: unknown = {},
): Promise<z.infer<Schema>> {
  return callRuntime({ socket, method, schema, input });
}

/** Calls the runtime; when nothing listens, starts it and repeats the call once. */
async function runtimeStarting<Schema extends z.ZodType>(
  method: string,
  schema: Schema,
  input: unknown = {},
): Promise<z.infer<Schema>> {
  try {
    return await runtime(method, schema, input);
  } catch (error) {
    if (!(error instanceof RuntimeUnavailableError)) throw error;

    const started = await ensureRuntime({ stateDir });
    if (!started.ok) throw new RuntimeNotStartedError(started.reason);
    return runtime(method, schema, input);
  }
}

/** Starts the runtime in the background; the next poll of the TUI finds it. */
function reviveRuntime(): void {
  void ensureRuntime({ stateDir }).catch(() => undefined);
}

function describeError(error: unknown): string {
  if (error instanceof RuntimeNotStartedError) {
    return `[оркестратор] runtime не запущен и сам не поднялся: ${error.message}`;
  }
  if (error instanceof RuntimeUnavailableError) return NOT_RUNNING;
  return `[оркестратор] ошибка: ${error instanceof Error ? error.message : String(error)}`;
}

function formatStatus(tasks: readonly TaskSummary[]): string {
  if (tasks.length === 0) return "[оркестратор] задач нет";
  const lines = tasks.map((task) => {
    const question = task.question ? `, вопрос ${task.question}` : "";
    return `- ${task.id} ${task.status} (${task.stage ?? "очередь"}${question}): ${task.text}`;
  });
  return ["[оркестратор] задачи:", ...lines].join("\n");
}

// OpenCode loads the default export of server.ts.
export default Plugin.define({
  id: "opencode-orchestrator",
  setup: async (ctx) => {
    reviveRuntime();

    await ctx.agent.transform((editor) => {
      editor.update(WORKER_AGENT, (agent) => {
        // Agent.Name is a branded string; the literal is a valid name.
        agent.name = WORKER_AGENT as typeof agent.name;
        agent.description =
          "Исполнитель этапа задачи оркестратора. Запускается runtime, не выбирай вручную.";
        agent.mode = "primary";
        agent.hidden = true;
        agent.permissions = [
          ...(agent.permissions ?? []),
          { action: "subagent", resource: "*", effect: "deny" },
        ];
      });
    });

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "stage_report",
        description:
          "Report the result of the current orchestrator stage. Call exactly once when the stage is finished: outcome passed when the work is done, stuck when you cannot continue.",
        options: { codemode: false },
        input: z.object({
          stageRunID: z.string().describe("The stageRunID given in the task prompt"),
          outcome: z.enum(["passed", "stuck"]),
          summary: z.string().describe("What was done, or what blocks you"),
        }),
        // The runtime reads the call input from the session history, so the handler only acknowledges.
        execute: async () => ({ content: "принято" }),
      });
    });

    await ctx.command.transform((editor) => {
      editor.add({
        name: "orchestrate",
        description:
          "Задача оркестратору: /orchestrate <текст>, /orchestrate stop <taskID>, без аргументов статус",
        execute: async ({ sessionID, prompt }) => {
          const reply = (text: string) =>
            ctx.session.synthetic({
              sessionID,
              id: `msg_oo${randomUUID().replaceAll("-", "")}`,
              text,
              // The TUI draws a synthetic message only through its description, never its text.
              description: text,
              resume: false,
            });
          const text = prompt.text.trim();
          const stop = /^stop\s+(\S+)\s*$/.exec(text);

          try {
            if (!text) {
              const { tasks } = await runtimeStarting("status", StatusReplySchema);
              await reply(formatStatus(tasks));
              return;
            }
            if (stop?.[1]) {
              const result = await runtimeStarting("task.stop", CommandReplySchema, {
                commandID: randomUUID(),
                taskID: stop[1],
              });
              await reply(
                result.ok
                  ? `[оркестратор] задача ${stop[1]} остановлена`
                  : `[оркестратор] не остановлена: ${result.error}`,
              );
              return;
            }

            const result = await runtimeStarting("task.start", CommandReplySchema, {
              commandID: randomUUID(),
              text,
              sessionID,
              directory: ctx.location.directory,
            });
            await reply(
              result.ok
                ? `[оркестратор] принята задача ${result.taskID}. Вопросы появятся в панели TUI, сводки придут сюда.`
                : `[оркестратор] задача не принята: ${result.error}`,
            );
          } catch (error) {
            await reply(describeError(error));
          }
        },
      });
    });

    await ctx.rpc.register(orchestratorRpc, {
      questions: async () => {
        try {
          const { questions } = await runtime("question.get", QuestionsReplySchema);
          return { available: true, questions };
        } catch (error) {
          if (error instanceof RuntimeUnavailableError) {
            reviveRuntime();
            return { available: false, questions: [] };
          }
          throw error;
        }
      },
      status: async () => {
        try {
          const { tasks } = await runtime("status", StatusReplySchema);
          return { available: true, tasks };
        } catch (error) {
          if (error instanceof RuntimeUnavailableError) {
            reviveRuntime();
            return { available: false, tasks: [] };
          }
          throw error;
        }
      },
      answer: async (input) => runtime("question.answer", CommandReplySchema, input),
    });
  },
});
