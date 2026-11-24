import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, test } from "vitest";
import { deriveId } from "../../src/core/ids.js";
import { discoverOpenCode, OpenCodeClient, type OpenCodeTarget, type SessionInfo } from "../../src/opencode.js";
import { callRuntime } from "../../src/rpc-client.js";
import { type RuntimeHandle, startRuntime } from "../../src/runtime.js";
import type { QuestionView, TaskSummary } from "../../src/service.js";
import { DEFAULT_ROUTE, makeRepo, sh } from "../harness.js";

// Seam 3: the same RPC against a real OpenCode 2.4.x service.
// ORCHESTRATOR_TEST_MODEL=provider/model enables it; the target service comes from
// ORCHESTRATOR_OPENCODE_URL / ORCHESTRATOR_OPENCODE_PASSWORD or $XDG_STATE_HOME/opencode/service.json.
// The service must load the plugin (global config `plugins`), otherwise orchestrator-worker is missing.

const modelSpec = process.env.ORCHESTRATOR_TEST_MODEL;
const LIVE_PREFIX = "/tmp/oo-live-";

async function raw(target: OpenCodeTarget, method: string, path: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (target.password) headers.authorization = `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`;
  const response = await fetch(new URL(path, target.url), { method, headers });
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

/** Deletes sessions left by earlier live runs: everything located under the live prefix. */
async function cleanTails(target: OpenCodeTarget, client: OpenCodeClient): Promise<number> {
  const listing = (await raw(target, "GET", "/api/session?limit=500")) as { data?: SessionInfo[] } | undefined;
  const tails = (listing?.data ?? []).filter((session) => /^(\/private)?\/tmp\/oo-live-/.test(session.location.directory));
  for (const session of tails) await client.deleteSession(session.id);
  return tails.length;
}

describe.skipIf(!modelSpec)("живая служба OpenCode", () => {
  const cleanup: (() => Promise<unknown> | unknown)[] = [];
  afterAll(async () => {
    for (const step of cleanup.reverse()) await Promise.resolve(step()).catch(() => undefined);
  });

  // случай 29
  test("задача доходит до коммита; после kill -9 runtime в сессии нет дубля задания", async () => {
    const [providerID = "", ...rest] = (modelSpec ?? "").split("/");
    const model = { providerID, id: rest.join("/") };
    const target = discoverOpenCode();
    const client = new OpenCodeClient(target);
    await cleanTails(target, client);

    const route = { ...DEFAULT_ROUTE, stages: [{ id: "code", uses: "code", model }, ...DEFAULT_ROUTE.stages.slice(1)] };
    const repo = makeRepo({ route, prefix: LIVE_PREFIX });
    const stateDir = mkdtempSync("/tmp/oo-live-state-");
    cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
    cleanup.push(() => cleanTails(target, client));
    cleanup.push(() => rmSync(repo, { recursive: true, force: true }));

    const lead = await client.createSession({
      id: deriveId("ses_", "live", repo),
      directory: repo,
      agent: "build",
      title: "orchestrator live lead",
      metadata: {},
      permissions: [],
    });
    const boot = () =>
      startRuntime({
        stateDir,
        opencode: target,
        tickMs: 1_000,
        retryBaseMs: 500,
        log: (line) => appendFileSync(process.env.ORCHESTRATOR_LIVE_LOG ?? "/dev/null", `${new Date().toISOString()} ${line}\n`),
      });
    let runtime: RuntimeHandle = await boot();
    cleanup.push(() => runtime.close());
    const rpc = <Result>(method: string, input: unknown = {}) => callRuntime(runtime.socket, method, input) as Promise<Result>;

    const started = await rpc<{ ok: boolean; taskID: string }>("task.start", {
      commandID: `live-${Date.now()}`,
      text: "Создай в корне репозитория файл hello.txt с одной строкой: hello from orchestrator. Больше ничего не меняй.",
      sessionID: lead.id,
      directory: repo,
    });
    expect(started.ok).toBe(true);

    const waitFor = async <Value>(probe: () => Promise<Value | undefined>, what: string, timeoutMs: number): Promise<Value> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = await probe().catch(() => undefined);
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error(`не дождался: ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    };
    const task = async () => (await rpc<{ tasks: TaskSummary[] }>("status")).tasks.find((candidate) => candidate.id === started.taskID);
    const workerID = deriveId("ses_", (await waitFor(async () => readSalt(stateDir), "соль", 10_000)) ?? "", started.taskID, "attempt-1");

    await waitFor(
      async () => ((await client.messages(workerID, repo))?.some((message) => message.type === "user") ? true : undefined),
      "задание доставлено",
      120_000,
    );
    runtime.crash();
    runtime = await boot();

    const question = await waitFor(
      async () =>
        (await rpc<{ questions: QuestionView[] }>("question.get")).questions.find((candidate) => candidate.taskID === started.taskID),
      "вопрос show",
      600_000,
    );
    expect(question.kind).toBe("show");
    expect(question.files.map((file) => file.path)).toContain("hello.txt");

    const prompts = (await client.messages(workerID, repo))?.filter((message) => message.type === "user") ?? [];
    expect(prompts).toHaveLength(1);
    const inbox = (await raw(target, "GET", `/api/session/${workerID}/inbox`)) as { data: unknown[] };
    expect(inbox.data).toEqual([]);

    const answer = await rpc<{ ok: boolean }>("question.answer", {
      commandID: "live-approve",
      questionID: question.questionID,
      choice: "approve",
      tree: question.tree,
    });
    expect(answer.ok).toBe(true);
    const done = await waitFor(async () => ((await task())?.status === "done" ? await task() : undefined), "done", 120_000);

    expect(sh(repo, `git rev-parse ${done.branch}^{tree}`)).toBe(question.tree);
    expect(sh(repo, `git show ${done.branch}:hello.txt`)).toContain("hello from orchestrator");
  });
});

function readSalt(stateDir: string): string | undefined {
  const db = new DatabaseSync(`${stateDir}/state.db`, { readOnly: true });
  try {
    return (db.prepare("SELECT value FROM meta WHERE key = 'salt'").get() as { value: string } | undefined)?.value;
  } finally {
    db.close();
  }
}
