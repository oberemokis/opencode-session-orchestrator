import { randomUUID } from "node:crypto";
import { Plugin } from "@opencode/plugin";
import { callRuntime, defaultStateDir, RuntimeUnavailableError, socketPath } from "opencode-orchestrator-runtime/rpc-client";
import { z } from "zod";
import { orchestratorRpc, type QuestionView, type TaskSummary } from "./rpc.ts";

const WORKER_AGENT = "orchestrator-worker";
const NOT_RUNNING = "[оркестратор] runtime не запущен. Запусти в терминале: opencode-orchestrator serve";

const socket = socketPath(defaultStateDir());

function runtime<Result>(method: string, input: unknown = {}): Promise<Result> {
  return callRuntime(socket, method, input) as Promise<Result>;
}

function describeError(error: unknown): string {
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
    await ctx.agent.transform((editor) => {
      editor.update(WORKER_AGENT, (agent) => {
        // Agent.Name is a branded string; the literal is a valid name.
        agent.name = WORKER_AGENT as typeof agent.name;
        agent.description = "Исполнитель этапа задачи оркестратора. Запускается runtime, не выбирай вручную.";
        agent.mode = "primary";
        agent.hidden = true;
        agent.permissions = [...(agent.permissions ?? []), { action: "subagent", resource: "*", effect: "deny" }];
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
        description: "Задача оркестратору: /orchestrate <текст>, /orchestrate stop <taskID>, без аргументов статус",
        execute: async ({ sessionID, prompt }) => {
          const reply = (text: string) =>
            ctx.session.synthetic({ sessionID, id: `msg_oo${randomUUID().replaceAll("-", "")}`, text, resume: false });
          const text = prompt.text.trim();
          const stop = /^stop\s+(\S+)\s*$/.exec(text);

          try {
            if (!text) {
              const { tasks } = await runtime<{ tasks: TaskSummary[] }>("status");
              await reply(formatStatus(tasks));
              return;
            }
            if (stop?.[1]) {
              const result = await runtime<{ ok: boolean; error?: string }>("task.stop", { commandID: randomUUID(), taskID: stop[1] });
              await reply(result.ok ? `[оркестратор] задача ${stop[1]} остановлена` : `[оркестратор] не остановлена: ${result.error}`);
              return;
            }

            const result = await runtime<{ ok: boolean; taskID?: string; error?: string }>("task.start", {
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
          const { questions } = await runtime<{ questions: QuestionView[] }>("question.get");
          return { available: true, questions };
        } catch (error) {
          if (error instanceof RuntimeUnavailableError) return { available: false, questions: [] };
          throw error;
        }
      },
      status: async () => {
        try {
          const { tasks } = await runtime<{ tasks: TaskSummary[] }>("status");
          return { available: true, tasks };
        } catch (error) {
          if (error instanceof RuntimeUnavailableError) return { available: false, tasks: [] };
          throw error;
        }
      },
      answer: async (input) => runtime("question.answer", input),
    });
  },
});
