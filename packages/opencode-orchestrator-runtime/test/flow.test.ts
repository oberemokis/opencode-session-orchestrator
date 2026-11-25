import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SHELL_DENY } from "../src/core/permissions.js";
import {
  answer,
  createHarness,
  DEFAULT_ROUTE,
  type Harness,
  makeRepo,
  sh,
  writingWorker,
} from "./harness.js";

let harness: Harness;
afterEach(async () => harness.dispose());

async function untilStatus(taskID: string, status: string) {
  return harness.waitFor(async () => {
    const task = await harness.task(taskID);
    return task.status === status ? task : undefined;
  }, `${taskID} в ${status}`);
}

function installHook(repo: string, script: string) {
  const hook = join(repo, ".git", "hooks", "pre-commit");
  writeFileSync(hook, `#!/bin/sh\n${script}\n`);
  chmodSync(hook, 0o755);
}

describe("маршрут code → show → deliver", () => {
  test("случай 12: доходит до коммита в ветке задачи с одобренным деревом", async () => {
    harness = await createHarness();
    harness.fake.onPrompt = writingWorker({ "hello.txt": "hi\n" });
    const repo = makeRepo();
    const lead = harness.fake.addLeadSession("ses_lead", repo);

    const taskID = await harness.start({ repo, sessionID: "ses_lead" });
    const question = await harness.waitFor(
      async () => (await harness.questions())[0],
      "вопрос show",
    );
    expect(question.kind).toBe("show");
    expect(question.files.map((file) => file.path)).toEqual(["hello.txt"]);

    expect(await answer(harness, { taskID, choice: "approve" })).toMatchObject({ ok: true });
    const done = await untilStatus(taskID, "done");

    expect(sh(repo, `git rev-parse ${done.branch}^{tree}`)).toBe(question.tree);
    expect(sh(repo, `git log -1 --format=%s ${done.branch}`)).toBe("Добавь файл hello.txt");
    expect(existsSync(done.worktree)).toBe(false);
    expect(sh(repo, "git branch --list")).toContain(done.branch);

    await harness.waitFor(() => lead.notes.length === 2, "две сводки");
    expect(lead.notes.map((note) => note.text)).toEqual([
      expect.stringContaining("ждёт просмотра диффа"),
      expect.stringContaining(`готова: коммит в ветке ${done.branch}`),
    ]);
    expect(lead.notes.every((note) => !note.resume)).toBe(true);
    // The TUI shows only the description of a synthetic message, so it must carry the phrase.
    expect(lead.notes.map((note) => note.description)).toEqual(lead.notes.map((note) => note.text));
    expect(lead.messages).toEqual([]);
  });

  test("случай 13: четвёртая задача ждёт места и стартует после завершения одной из трёх", async () => {
    harness = await createHarness({ slots: 3 });
    const repo = makeRepo();
    harness.fake.onPrompt = (call) => {
      if (call.text.includes("четвёртая")) writingWorker({ "four.txt": "4" })(call);
    };

    const first = await harness.start({ repo, text: "первая" });
    await harness.start({ repo, text: "вторая" });
    await harness.start({ repo, text: "третья" });
    const fourth = await harness.start({ repo, text: "четвёртая" });

    await harness.waitFor(async () => harness.fake.sessions.size === 3, "три сессии");
    expect((await harness.task(fourth)).status).toBe("queued");

    await harness.rpc("task.stop", { commandID: "stop-1", taskID: first });
    await harness.waitFor(
      async () => (await harness.task(fourth)).status === "waiting",
      "четвёртая дошла до show",
    );
  });
});

describe("коммит и хуки", () => {
  /** The first code pass writes hello.txt; later passes behave as `later` says. */
  async function toDeliver(repo: string, later: Harness["fake"]["onPrompt"]) {
    harness = await createHarness();
    const first = writingWorker({ "hello.txt": "hi\n" });
    let calls = 0;
    harness.fake.onPrompt = (call) => (calls++ === 0 ? first(call) : later(call));
    const taskID = await harness.start({ repo });
    await answer(harness, { taskID, choice: "approve" });
    return taskID;
  }

  test("случай 19: отказ pre-commit хука возвращает задачу на code с выводом хука", async () => {
    const repo = makeRepo();
    installHook(repo, 'echo "lint: missing semicolon" >&2; exit 1');
    const taskID = await toDeliver(repo, () => {});

    await harness.waitFor(
      () =>
        [...harness.fake.sessions.values()]
          .flatMap((session) => session.messages)
          .filter((message) => message.type === "user").length >= 2,
      "повторный code",
    );
    const prompts = [...harness.fake.sessions.values()]
      .flatMap((session) => session.messages)
      .filter((message) => message.type === "user");
    expect(prompts.at(-1)?.text).toContain("lint: missing semicolon");
    expect((await harness.task(taskID)).stage).toBe("code");
  });

  test("случай 20: хук, изменивший файлы, откатывает коммит, правки остаются, затем снова code и show", async () => {
    const repo = makeRepo();
    installHook(repo, 'printf "formatted\\n" > hello.txt && git add hello.txt');
    const taskID = await toDeliver(repo, (call) => {
      call.report({ outcome: "passed", summary: "правки хука приняты" });
      call.idle();
    });

    const task = await harness.waitFor(async () => {
      const current = await harness.task(taskID);
      return current.stage === "show" &&
        current.status === "waiting" &&
        (await harness.questions())[0]?.files[0]
        ? current
        : undefined;
    }, "второй show");
    expect(sh(repo, `git rev-list --count main..${task.branch}`)).toBe("0");
    expect(readFileSync(join(task.worktree, "hello.txt"), "utf8")).toBe("formatted\n");
    expect((await harness.questions())[0]?.files[0]?.patch).toContain("+formatted");
  });

  test("случай 21: файл, появившийся после одобрения, в коммит не попадает", async () => {
    harness = await createHarness();
    harness.fake.onPrompt = writingWorker({ "hello.txt": "hi\n" });
    const repo = makeRepo();
    installHook(repo, "sleep 0.3");
    const taskID = await harness.start({ repo });
    const question = await harness.waitFor(async () => (await harness.questions())[0], "show");

    const worktree = (await harness.task(taskID)).worktree;
    writeFileSync(join(worktree, "late.txt"), "late\n");
    await answer(harness, { taskID, choice: "approve" });
    const done = await untilStatus(taskID, "done");

    expect(sh(repo, `git rev-parse ${done.branch}^{tree}`)).toBe(question.tree);
    expect(sh(repo, `git ls-tree --name-only ${done.branch}`)).not.toContain("late.txt");
  });
});

describe("подготовка, модель, права", () => {
  test("случай 25: текст «нужны правки» переживает рестарт runtime и попадает в задание повторного code", async () => {
    harness = await createHarness();
    harness.fake.onPrompt = writingWorker({ "hello.txt": "hi\n" });
    const repo = makeRepo();
    const taskID = await harness.start({ repo });
    await harness.waitFor(async () => (await harness.questions())[0], "show");

    harness.fake.onPrompt = () => {};
    await answer(harness, {
      taskID,
      choice: "changes-requested",
      text: "назови файл greeting.txt",
    });
    await harness.restart("crash");

    const prompt = await harness.waitFor(
      () =>
        [...harness.fake.sessions.values()]
          .flatMap((session) => session.messages)
          .find((message) => message.text?.includes("greeting.txt")),
      "задание с замечанием",
    );
    expect(prompt.text).toContain("Человек попросил правки");
  });

  test("случай 26: модель этапа подтверждена до задания, неизвестная модель даёт blocked без задания", async () => {
    harness = await createHarness();
    const withModel = (id: string) => ({
      ...DEFAULT_ROUTE,
      stages: [
        { id: "code", uses: "code", model: { providerID: "openai", id } },
        ...DEFAULT_ROUTE.stages.slice(1),
      ],
    });

    const good = await harness.start({ repo: makeRepo({ route: withModel("gpt-5.6-luna") }) });
    const session = await harness.waitFor(
      () =>
        [...harness.fake.sessions.values()].find((candidate) =>
          candidate.messages.some((message) => message.type === "user"),
        ),
      "задание",
    );
    const switched = session.messages.findIndex((message) => message.type === "model-switched");
    expect(switched).toBeGreaterThanOrEqual(0);
    expect(switched).toBeLessThan(session.messages.findIndex((message) => message.type === "user"));
    expect(good).toBeTruthy();

    const bad = await harness.start({ repo: makeRepo({ route: withModel("gpt-0-nope") }) });
    await untilStatus(bad, "blocked");
    const badSession = [...harness.fake.sessions.values()].find(
      (candidate) => candidate.metadata.orchestratorTask === bad,
    );
    expect(badSession?.messages.some((message) => message.type === "user")).toBe(false);
  });

  test("случай 33: worktree получает файлы setup.copy и проходит setup.command до сессии; сбой даёт blocked без задания", async () => {
    harness = await createHarness();
    const repo = makeRepo({
      config: { setup: { copy: [".env.local"], command: "cat .env.local > prepared.txt" } },
    });
    writeFileSync(join(repo, ".env.local"), "SECRET=1\n");
    harness.fake.onPrompt = (call) => {
      expect(readFileSync(join(call.session.directory, "prepared.txt"), "utf8")).toBe("SECRET=1\n");
      writingWorker({ "a.txt": "a" })(call);
    };
    const ok = await harness.start({ repo });
    await untilStatus(ok, "waiting");

    const failing = makeRepo({ config: { setup: { command: "echo boom >&2; exit 3" } } });
    const bad = await harness.start({ repo: failing });
    await untilStatus(bad, "blocked");
    const question = (await harness.questions()).find((candidate) => candidate.taskID === bad);
    expect(question?.reason).toContain("boom");
    expect(
      [...harness.fake.sessions.values()].some(
        (session) => session.metadata.orchestratorTask === bad,
      ),
    ).toBe(false);
  });

  test("случай 35: правила сессии: общий список, deny проекта, MCP закрыт кроме mcpRead", async () => {
    harness = await createHarness();
    const repo = makeRepo({ config: { deny: ["*npm publish*"], mcpRead: ["YouTrack_get_issue"] } });
    await harness.start({ repo });
    const session = await harness.waitFor(() => [...harness.fake.sessions.values()][0], "сессия");

    expect(session.agent).toBe("orchestrator-worker");
    expect(session.permissions).toEqual([
      ...SHELL_DENY.map((resource) => ({ action: "shell", resource, effect: "deny" })),
      { action: "shell", resource: "*npm publish*", effect: "deny" },
      { action: "edit", resource: "opencode.json", effect: "deny" },
      { action: "edit", resource: "opencode.jsonc", effect: "deny" },
      { action: "edit", resource: ".opencode/*", effect: "deny" },
      { action: "external_directory", resource: "*", effect: "deny" },
      { action: "YouTrack_*", resource: "*", effect: "deny" },
      { action: "gitlab_*", resource: "*", effect: "deny" },
      { action: "YouTrack_get_issue", resource: "*", effect: "allow" },
    ]);
  });
});
