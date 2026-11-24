import { afterEach, describe, expect, test } from "vitest";
import type { FakeSession } from "./fake-opencode.js";
import { answer, createHarness, DEFAULT_ROUTE, type Harness, makeRepo, writingWorker } from "./harness.js";

let harness: Harness;
afterEach(async () => harness?.dispose());

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

function sessions(): FakeSession[] {
  return [...harness.fake.sessions.values()];
}

function userPrompts(): number {
  return sessions().reduce((sum, session) => sum + session.messages.filter((message) => message.type === "user").length, 0);
}

function workerSession(taskID: string): FakeSession | undefined {
  return sessions().find((session) => session.metadata.orchestratorTask === taskID);
}

describe("рестарт runtime", () => {
  // случай 14
  test.each(["сразу после task.start", "на открытом вопросе"])(
    "убит %s: задачи и вопросы те же, лишних сессий и сообщений нет",
    async (moment) => {
      harness = await createHarness();
      harness.fake.onPrompt = writingWorker({ "hello.txt": "hi\n" });
      const taskID = await harness.start({ repo: makeRepo() });

      if (moment === "на открытом вопросе") await harness.waitFor(async () => (await harness.questions())[0], "show");
      const before = { questions: await harness.questions(), sessions: harness.fake.sessions.size };

      await harness.restart("crash");
      const question = await harness.waitFor(async () => (await harness.questions())[0], "show после рестарта");
      await settle();

      if (moment === "на открытом вопросе") expect(await harness.questions()).toEqual(before.questions);
      expect(question.taskID).toBe(taskID);
      expect(harness.fake.sessions.size).toBe(1);
      expect(userPrompts()).toBe(1);
    },
  );

  // случай 15
  test("отчёт, записанный пока runtime лежал, продвигает задачу ровно один раз; засчитан последний непустой", async () => {
    harness = await createHarness();
    const taskID = await harness.start({ repo: makeRepo() });
    const session = await harness
      .waitFor(() => workerSession(taskID)?.messages.length, "задание доставлено")
      .then(() => workerSession(taskID));
    if (!session) throw new Error("нет сессии");

    harness.runtime.crash();
    const call = harness.fake.callFor(session, session.messages[0]?.text ?? "");
    call.report({ outcome: "passed", summary: "первый" });
    call.report({ outcome: "stuck", summary: "последний непустой" });
    call.report({});
    call.idle();
    await harness.boot();

    const task = await harness.waitFor(async () => {
      const current = await harness.task(taskID);
      return current.status === "waiting" ? current : undefined;
    }, "решение по отчёту");
    await settle();

    const questions = await harness.questions();
    expect(task.stage).toBe("code");
    expect(questions).toHaveLength(1);
    expect(questions[0]?.reason).toContain("последний непустой");
  });

  // случай 16
  test("отчёт, дописанный в уже прочитанное сообщение, находится", async () => {
    harness = await createHarness();
    harness.fake.onPrompt = (call) => call.push({ type: "assistant", finish: "tool-calls", content: [] });
    const taskID = await harness.start({ repo: makeRepo() });
    const session = await harness.waitFor(
      () => workerSession(taskID)?.messages.find((message) => message.type === "assistant") && workerSession(taskID),
      "ответ",
    );
    await settle(200);

    const assistant = session.messages.find((message) => message.type === "assistant");
    const stageRunID = /stageRunID "([^"]+)"/.exec(session.messages[0]?.text ?? "")?.[1];
    assistant?.content?.push({
      type: "tool",
      id: "call_late",
      name: "stage_report",
      state: { status: "completed", input: { stageRunID, outcome: "passed", summary: "дописан" } },
    });
    harness.fake.callFor(session, "").idle();

    await harness.waitFor(async () => (await harness.task(taskID)).stage === "show", "переход в show");
  });

  // случай 17
  test.each([
    ["без отчёта", (call: Parameters<typeof harness.fake.onPrompt>[0]) => call.idle()],
    [
      "с пустым входом",
      (call: Parameters<typeof harness.fake.onPrompt>[0]) => {
        call.report({});
        call.idle();
      },
    ],
  ])("ход закончился %s: этап сразу получает stuck", async (_name, worker) => {
    harness = await createHarness();
    harness.fake.onPrompt = worker;
    const taskID = await harness.start({ repo: makeRepo() });

    const question = await harness.waitFor(
      async () => (await harness.questions()).find((candidate) => candidate.taskID === taskID),
      "escalate",
    );
    expect(question.kind).toBe("escalate");
    expect(question.reason).toContain("без stage_report");
  });

  // случай 18
  test("после notice restart runtime ничего не шлёт до конца хода; простой, пока OpenCode лежит, не считается", async () => {
    harness = await createHarness({ stallUnitMs: 400 });
    const route = {
      ...DEFAULT_ROUTE,
      stages: [{ id: "code", uses: "code", limits: { stallMinutes: 1 } }, ...DEFAULT_ROUTE.stages.slice(1)],
    };
    harness.fake.onPrompt = (call) => {
      call.push({ type: "assistant", finish: "error", content: [] });
      call.idle("failed");
      call.push({ type: "synthetic", metadata: { notice: "restart" }, text: "continue" });
    };
    const taskID = await harness.start({ repo: makeRepo({ route }) });
    await harness.waitFor(() => workerSession(taskID)?.messages.some((message) => message.metadata?.notice === "restart"), "notice");

    harness.fake.down = true;
    await settle(900);
    harness.fake.down = false;
    await settle(150);

    expect((await harness.task(taskID)).status).toBe("active");
    expect(userPrompts()).toBe(1);

    const stalled = await harness.waitFor(
      async () => (await harness.questions()).find((candidate) => candidate.taskID === taskID),
      "простой",
      5_000,
    );
    expect(stalled.reason).toContain("не отвечает");
    expect(workerSession(taskID)?.interrupted).toBe(1);
  });
});

describe("коллизии, маршрут, команды", () => {
  // случай 22
  test("сессия с тем же ID в другом каталоге даёт blocked без сообщений; новая попытка создаёт новую сессию", async () => {
    harness = await createHarness();
    harness.fake.hijackNextSession = "/somewhere/else";
    harness.fake.onPrompt = writingWorker({ "a.txt": "a" });
    const taskID = await harness.start({ repo: makeRepo() });

    const blocked = await harness.waitFor(
      async () => (await harness.questions()).find((candidate) => candidate.kind === "blocked"),
      "blocked",
    );
    expect(blocked.reason).toContain("/somewhere/else");
    const foreign = sessions()[0];
    expect(foreign?.messages).toEqual([]);

    await answer(harness, { taskID, choice: "retry" });
    await harness.waitFor(async () => (await harness.task(taskID)).stage === "show", "show после новой попытки");
    expect(harness.fake.sessions.size).toBe(2);
    expect(foreign?.messages).toEqual([]);
  });

  // случай 23
  test("невалидный маршрут отклоняет task.start с путём к полю, остальные задачи идут", async () => {
    harness = await createHarness();
    harness.fake.onPrompt = writingWorker({ "a.txt": "a" });
    const broken = makeRepo({ route: { schemaVersion: 1, id: "x", stages: [{ id: "code", uses: "code", on: { stuck: "goto:nope" } }] } });

    const rejected = await harness.rpc<{ ok: boolean; error: string }>("task.start", {
      commandID: "c1",
      text: "t",
      sessionID: "ses_l",
      directory: broken,
    });
    expect(rejected).toMatchObject({ ok: false, error: expect.stringContaining("stages.0.on.stuck") });

    const taskID = await harness.start({ repo: makeRepo() });
    await harness.waitFor(async () => (await harness.task(taskID)).status === "waiting", "вторая задача идёт");
  });

  // случай 24
  test("повтор question.answer с тем же commandID даёт тот же результат, конфликтующий ответ отклонён", async () => {
    harness = await createHarness();
    harness.fake.onPrompt = writingWorker({ "a.txt": "a" });
    const taskID = await harness.start({ repo: makeRepo() });
    const question = await harness.waitFor(async () => (await harness.questions())[0], "show");
    const request = { commandID: "answer-1", questionID: question.questionID, choice: "approve", tree: question.tree };

    const first = await harness.rpc("question.answer", request);
    const repeat = await harness.rpc("question.answer", request);
    const conflicting = await harness.rpc("question.answer", {
      ...request,
      commandID: "answer-2",
      choice: "changes-requested",
      text: "нет",
    });

    expect(first).toMatchObject({ ok: true, taskID });
    expect(repeat).toEqual(first);
    expect(conflicting).toMatchObject({ ok: false, error: "вопрос уже закрыт" });
  });

  test("повтор task.start с тем же commandID не создаёт вторую задачу", async () => {
    harness = await createHarness();
    const repo = makeRepo();
    const first = await harness.start({ repo, commandID: "msg_same" });
    const second = await harness.start({ repo, commandID: "msg_same" });

    expect(second).toBe(first);
    expect((await harness.rpc<{ tasks: unknown[] }>("status")).tasks).toHaveLength(1);
  });
});
