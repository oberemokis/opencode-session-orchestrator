import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callRuntime } from "../src/rpc-client.js";
import { type RuntimeHandle, startRuntime } from "../src/runtime.js";
import type { QuestionView, TaskSummary } from "../src/service.js";
import { FakeOpenCode } from "./fake-opencode.js";

// Real git, isolated from the developer's global config (signing, hooks path, identity).
const gitHome = mkdtempSync("/tmp/oo-git-");
writeFileSync(join(gitHome, "gitconfig"), "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
process.env.GIT_CONFIG_GLOBAL = join(gitHome, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";

export const DEFAULT_ROUTE = {
  schemaVersion: 1,
  id: "default",
  stages: [
    { id: "code", uses: "code" },
    { id: "show", uses: "show" },
    { id: "deliver", uses: "deliver", delivery: { type: "local-commit" }, on: { failed: "goto:code" } },
  ],
};

export function sh(cwd: string, command: string): string {
  return execFileSync("sh", ["-c", command], { cwd, encoding: "utf8" }).trim();
}

export function makeRepo(input: { route?: unknown; config?: unknown; files?: Record<string, string>; prefix?: string } = {}): string {
  const repo = realpathSync(mkdtempSync(input.prefix ?? "/tmp/oo-repo-"));
  mkdirSync(join(repo, ".orchestrator", "workflows"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# demo\n");
  writeFileSync(join(repo, ".orchestrator", "workflows", "default.json"), JSON.stringify(input.route ?? DEFAULT_ROUTE));
  if (input.config) writeFileSync(join(repo, ".orchestrator", "config.json"), JSON.stringify(input.config));
  for (const [path, content] of Object.entries(input.files ?? {})) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  sh(repo, "git init -q && git add -A && git commit -q -m init");
  return repo;
}

export interface Harness {
  readonly fake: FakeOpenCode;
  readonly stateDir: string;
  readonly logs: string[];
  runtime: RuntimeHandle;
  rpc<Result = Record<string, unknown>>(method: string, input?: unknown): Promise<Result>;
  restart(mode: "crash" | "close"): Promise<void>;
  /** Boots a new runtime on the same state dir after crash(). */
  boot(): Promise<void>;
  start(input: { repo: string; text?: string; commandID?: string; sessionID?: string }): Promise<string>;
  task(taskID: string): Promise<TaskSummary>;
  questions(): Promise<QuestionView[]>;
  waitFor<Value>(probe: () => Value | Promise<Value>, what: string, timeoutMs?: number): Promise<NonNullable<Value>>;
  dispose(): Promise<void>;
}

export async function createHarness(options: { slots?: number; fake?: FakeOpenCode; stallUnitMs?: number } = {}): Promise<Harness> {
  const fake = options.fake ?? (await new FakeOpenCode().start());
  const stateDir = mkdtempSync("/tmp/oo-state-");
  const logs: string[] = [];
  const boot = () =>
    startRuntime({
      stateDir,
      opencode: { url: fake.url, password: null },
      slots: options.slots ?? 3,
      tickMs: 50,
      retryBaseMs: 10,
      maxIntentAttempts: 3,
      stallUnitMs: options.stallUnitMs ?? 60_000,
      skipStartupChecks: true,
      log: (line) => logs.push(line),
    });

  const harness: Harness = {
    fake,
    stateDir,
    logs,
    runtime: await boot(),
    rpc: (method, input) => callRuntime(harness.runtime.socket, method, input ?? {}) as never,
    async boot() {
      harness.runtime = await boot();
    },
    async restart(mode) {
      if (mode === "crash") harness.runtime.crash();
      else await harness.runtime.close();
      harness.runtime = await boot();
    },
    async start({ repo, text = "Добавь файл hello.txt", commandID = `cmd-${Math.random()}`, sessionID = "ses_lead" }) {
      const result = await harness.rpc<{ ok: boolean; taskID?: string; error?: string }>("task.start", {
        commandID,
        text,
        sessionID,
        directory: repo,
      });
      if (!result.ok || !result.taskID) throw new Error(`task.start: ${result.error}`);
      return result.taskID;
    },
    async task(taskID) {
      const { tasks } = await harness.rpc<{ tasks: TaskSummary[] }>("status");
      const found = tasks.find((task) => task.id === taskID);
      if (!found) throw new Error(`нет задачи ${taskID}`);
      return found;
    },
    async questions() {
      return (await harness.rpc<{ questions: QuestionView[] }>("question.get")).questions;
    },
    async waitFor(probe, what, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = await probe();
        if (value !== undefined && value !== null && value !== false) return value as NonNullable<typeof value>;
        if (Date.now() > deadline) throw new Error(`не дождался: ${what}\n${logs.slice(-15).join("\n")}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async dispose() {
      await harness.runtime.close().catch(() => undefined);
      if (!options.fake) await fake.close();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
  return harness;
}

/** Worker that writes `files` into its worktree and reports `passed`. */
export function writingWorker(files: Record<string, string>) {
  return (call: import("./fake-opencode.js").PromptCall) => {
    for (const [path, content] of Object.entries(files)) writeFileSync(join(call.session.directory, path), content);
    call.report({ outcome: "passed", summary: "сделано" });
    call.idle();
  };
}

export async function answer(harness: Harness, input: { taskID: string; choice: string; text?: string; commandID?: string }) {
  const question = await harness.waitFor(
    async () => (await harness.questions()).find((candidate) => candidate.taskID === input.taskID),
    `вопрос ${input.taskID}`,
  );
  return harness.rpc<{ ok: boolean; error?: string; status?: string }>("question.answer", {
    commandID: input.commandID ?? `ans-${Math.random()}`,
    questionID: question.questionID,
    choice: input.choice,
    text: input.text,
    tree: question.tree ?? undefined,
  });
}
