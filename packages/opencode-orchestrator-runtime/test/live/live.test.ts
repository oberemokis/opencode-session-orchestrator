import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { deriveId } from "../../src/core/ids.js";
import { discoverOpenCode, OpenCodeClient, type OpenCodeTarget } from "../../src/opencode.js";
import { callRuntime } from "../../src/rpc-client.js";
import {
  CommandReplySchema,
  QuestionsReplySchema,
  StatusReplySchema,
} from "../../src/rpc-contract.js";
import { type RuntimeHandle, startRuntime } from "../../src/runtime.js";
import { DEFAULT_ROUTE, makeRepo, sh } from "../harness.js";

// Seam 3: the same RPC against a real OpenCode 2.4.x service.
// ORCHESTRATOR_TEST_MODEL=provider/model enables it; the target service comes from
// ORCHESTRATOR_OPENCODE_URL / ORCHESTRATOR_OPENCODE_PASSWORD or $XDG_STATE_HOME/opencode/service.json.
// The service must load the plugin (global config `plugins`), otherwise orchestrator-worker is missing.

const modelSpec = process.env.ORCHESTRATOR_TEST_MODEL;
const LIVE_PREFIX = "/tmp/oo-live-";

const SessionListSchema = z.looseObject({
  data: z
    .array(z.looseObject({ id: z.string(), location: z.looseObject({ directory: z.string() }) }))
    .optional(),
});
const InboxSchema = z.looseObject({ data: z.array(z.unknown()) });

async function raw<Schema extends z.ZodType>(
  target: OpenCodeTarget,
  request: { method: string; path: string; schema: Schema },
): Promise<z.infer<Schema> | undefined> {
  const headers: Record<string, string> = {};
  if (target.password)
    headers.authorization = `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`;
  const response = await fetch(new URL(request.path, target.url), {
    method: request.method,
    headers,
  });
  const text = await response.text();
  return text ? request.schema.parse(JSON.parse(text)) : undefined;
}

/** Deletes sessions left by earlier live runs: everything located under the live prefix. */
async function cleanTails(target: OpenCodeTarget, client: OpenCodeClient): Promise<number> {
  const listing = await raw(target, {
    method: "GET",
    path: "/api/session?limit=500",
    schema: SessionListSchema,
  });
  const tails = (listing?.data ?? []).filter((session) =>
    /^(\/private)?\/tmp\/oo-live-/.test(session.location.directory),
  );
  for (const session of tails) await client.deleteSession(session.id);
  return tails.length;
}

describe.skipIf(!modelSpec)("живая служба OpenCode", () => {
  const cleanup: (() => Promise<unknown> | unknown)[] = [];
  afterAll(async () => {
    for (const step of cleanup.reverse()) await Promise.resolve(step()).catch(() => undefined);
  });

  test("случай 29: задача доходит до коммита; после kill -9 runtime в сессии нет дубля задания", async () => {
    const [providerID = "", ...rest] = (modelSpec ?? "").split("/");
    const model = { providerID, id: rest.join("/") };
    const target = discoverOpenCode();
    const client = new OpenCodeClient(target);
    await cleanTails(target, client);

    const route = {
      ...DEFAULT_ROUTE,
      stages: [{ id: "code", uses: "code", model }, ...DEFAULT_ROUTE.stages.slice(1)],
    };
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
        log: (line) =>
          appendFileSync(
            process.env.ORCHESTRATOR_LIVE_LOG ?? "/dev/null",
            `${new Date().toISOString()} ${line}\n`,
          ),
      });
    let runtime: RuntimeHandle = await boot();
    cleanup.push(() => runtime.close());
    const rpc = <Schema extends z.ZodType>(method: string, schema: Schema, input: unknown = {}) =>
      callRuntime({ socket: runtime.socket, method, schema, input });

    const started = await rpc("task.start", CommandReplySchema, {
      commandID: `live-${Date.now()}`,
      text: "Создай в корне репозитория файл hello.txt с одной строкой: hello from orchestrator. Больше ничего не меняй.",
      sessionID: lead.id,
      directory: repo,
    });
    if (!started.ok) throw new Error(`task.start: ${started.error}`);

    const waitFor = async <Value>(
      probe: () => Promise<Value | undefined>,
      what: string,
      timeoutMs: number,
    ): Promise<Value> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = await probe().catch(() => undefined);
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error(`не дождался: ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    };
    const task = async () =>
      (await rpc("status", StatusReplySchema)).tasks.find(
        (candidate) => candidate.id === started.taskID,
      );
    const workerID = deriveId(
      "ses_",
      (await waitFor(async () => readSalt(stateDir), "соль", 10_000)) ?? "",
      started.taskID,
      "attempt-1",
    );

    await waitFor(
      async () =>
        (await client.messages(workerID, repo))?.some((message) => message.type === "user")
          ? true
          : undefined,
      "задание доставлено",
      120_000,
    );
    runtime.crash();
    runtime = await boot();

    const question = await waitFor(
      async () =>
        (await rpc("question.get", QuestionsReplySchema)).questions.find(
          (candidate) => candidate.taskID === started.taskID,
        ),
      "вопрос show",
      600_000,
    );
    expect(question.kind).toBe("show");
    expect(question.files.map((file) => file.path)).toContain("hello.txt");

    const prompts =
      (await client.messages(workerID, repo))?.filter((message) => message.type === "user") ?? [];
    expect(prompts).toHaveLength(1);
    const inbox = await raw(target, {
      method: "GET",
      path: `/api/session/${workerID}/inbox`,
      schema: InboxSchema,
    });
    expect(inbox?.data).toEqual([]);

    const answer = await rpc("question.answer", CommandReplySchema, {
      commandID: "live-approve",
      questionID: question.questionID,
      choice: "approve",
      tree: question.tree,
    });
    expect(answer.ok).toBe(true);
    const done = await waitFor(
      async () => ((await task())?.status === "done" ? await task() : undefined),
      "done",
      120_000,
    );

    expect(sh(repo, `git rev-parse ${done.branch}^{tree}`)).toBe(question.tree);
    expect(sh(repo, `git show ${done.branch}:hello.txt`)).toContain("hello from orchestrator");
  });
});

function readSalt(stateDir: string): string | undefined {
  const db = new DatabaseSync(`${stateDir}/state.db`, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'salt'").get();
    return row === undefined ? undefined : z.object({ value: z.string() }).parse(row).value;
  } finally {
    db.close();
  }
}
