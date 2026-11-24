#!/usr/bin/env node
import { discoverOpenCode } from "./opencode.js";
import { callRuntime, defaultStateDir, RuntimeUnavailableError, socketPath } from "./rpc-client.js";
import { StatusReplySchema } from "./rpc-contract.js";
import { startRuntime } from "./runtime.js";

const USAGE = `opencode-orchestrator <команда>

  serve    запустить runtime (передний план, Ctrl+C останавливает)
  status   показать задачи

Переменные: ORCHESTRATOR_STATE_DIR (по умолчанию ~/.local/state/opencode-orchestrator),
ORCHESTRATOR_SLOTS (3), ORCHESTRATOR_OPENCODE_URL и ORCHESTRATOR_OPENCODE_PASSWORD
(по умолчанию из $XDG_STATE_HOME/opencode/service.json).`;

async function serve(): Promise<void> {
  const stateDir = defaultStateDir();
  const runtime = await startRuntime({
    stateDir,
    opencode: discoverOpenCode(),
    slots: Number(process.env.ORCHESTRATOR_SLOTS ?? 3),
  });
  console.log(`runtime слушает ${runtime.socket}`);

  const shutdown = () => {
    console.log("останавливаюсь");
    void runtime.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function status(): Promise<void> {
  const { tasks } = await callRuntime({
    socket: socketPath(defaultStateDir()),
    method: "status",
    schema: StatusReplySchema,
  });
  if (tasks.length === 0) {
    console.log("задач нет");
    return;
  }
  for (const task of tasks) {
    const question = task.question ? ` вопрос:${task.question}` : "";
    console.log(
      `${task.id}  ${task.status.padEnd(7)} ${(task.stage ?? "-").padEnd(10)}${question}  ${task.text}`,
    );
  }
}

async function main(command: string | undefined): Promise<void> {
  if (command === "serve") return serve();
  if (command === "status") return status();
  console.log(USAGE);
  if (command && command !== "help" && command !== "--help") process.exitCode = 2;
}

main(process.argv[2]).catch((error: unknown) => {
  if (error instanceof RuntimeUnavailableError)
    console.error("runtime не запущен: opencode-orchestrator serve");
  else console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
