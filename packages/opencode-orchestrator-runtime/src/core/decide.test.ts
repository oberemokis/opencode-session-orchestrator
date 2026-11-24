import { describe, expect, test } from "vitest";
import { decide } from "./decide.js";
import { apply, atDeliver, atShow, kinds, makeTask, runID, startedTask } from "./test-support.js";
import type { TaskState } from "./types.js";

const CODE_TWICE = {
  schemaVersion: 1,
  id: "r",
  stages: [
    { id: "code", uses: "code", limits: { retries: 1 } },
    { id: "review", uses: "code", on: { stuck: "goto:code" } },
    { id: "show", uses: "show" },
    { id: "deliver", uses: "deliver", delivery: { type: "local-commit" } },
  ],
};

function report(state: TaskState, outcome: "passed" | "stuck") {
  return apply(state, { type: "stage-reported", stageRunID: runID(state), outcome, summary: "s" });
}

function stageOf(state: TaskState): string | undefined {
  return state.workflow.stages[state.stageIndex]?.id;
}

describe("decide", () => {
  test("место запускает попытку: worktree, подготовка, сессия, затем задание", () => {
    const granted = apply(makeTask(), { type: "slot-granted" });
    expect(kinds(granted.intents)).toEqual([
      "ensure-worktree",
      "prepare-worktree",
      "create-session",
    ]);

    const confirmed = apply(granted.state, { type: "session-confirmed", attempt: 1 });
    expect(kinds(confirmed.intents)).toEqual(["send-prompt"]);
    expect(confirmed.intents[0]).toMatchObject({
      text: expect.stringContaining(runID(confirmed.state)),
    });
  });

  test("случай 1: passed без ключа в on ведёт дальше, stuck без ключа к escalate", () => {
    expect(stageOf(report(startedTask(), "passed").state)).toBe("show");

    const stuck = report(startedTask(), "stuck").state;
    expect(stuck.status).toBe("waiting");
    expect(stuck.question).toMatchObject({ kind: "escalate", options: ["repeat", "next", "stop"] });
  });

  test("случай 2: автоматический возврат тратит повтор целевого этапа, исчерпание даёт escalate", () => {
    const atReview = report(startedTask(CODE_TWICE), "passed").state;
    const back = report(atReview, "stuck");
    expect(stageOf(back.state)).toBe("code");
    expect(back.state.retries).toEqual({ code: 1 });

    const reviewAgain = report(back.state, "passed").state;
    const exhausted = report(reviewAgain, "stuck").state;
    expect(stageOf(exhausted)).toBe("review");
    expect(exhausted.question).toMatchObject({
      kind: "escalate",
      reason: expect.stringContaining("исчерпаны повторы"),
    });
  });

  test("выбор человека счётчик не трогает", () => {
    const showing = atShow("tree1");
    const questionID = showing.question?.id ?? "";
    const again = apply(showing, {
      type: "answered",
      questionID,
      choice: "changes-requested",
      text: "поправь",
      tree: "tree1",
    });
    expect(again.state.retries).toEqual({});
  });

  test("случай 3: approve записывает дерево из вопроса, changes-requested ведёт на code с текстом", () => {
    const delivering = atDeliver("tree1");
    expect(delivering.reviewedTree).toBe("tree1");
    expect(stageOf(delivering)).toBe("deliver");

    const showing = atShow("tree1");
    const changes = apply(showing, {
      type: "answered",
      questionID: showing.question?.id ?? "",
      choice: "changes-requested",
      text: "переименуй функцию",
      tree: "tree1",
    });
    expect(stageOf(changes.state)).toBe("code");
    expect(changes.intents.find((intent) => intent.kind === "send-prompt")).toMatchObject({
      text: expect.stringContaining("переименуй функцию"),
    });
  });

  test("случай 4: deliver без reviewedTree, равного текущему дереву, даёт escalate", () => {
    const showing = atShow("tree1");
    const stale = { ...showing, tree: "tree2", question: null, reviewedTree: "tree1" };
    const decision = decide(
      { ...stale, question: showing.question },
      {
        type: "answered",
        questionID: showing.question?.id ?? "",
        choice: "approve",
        tree: "tree1",
      },
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.state.question).toMatchObject({ kind: "escalate" });
    expect(kinds(decision.intents)).not.toContain("commit");
  });

  test("deliver с одобренным деревом коммитит именно его", () => {
    const showing = atShow("tree1");
    const approved = apply(showing, {
      type: "answered",
      questionID: showing.question?.id ?? "",
      choice: "approve",
      tree: "tree1",
    });
    expect(approved.intents.find((intent) => intent.kind === "commit")).toMatchObject({
      tree: "tree1",
      base: "base0",
    });
  });

  test.each(["hook-rejected", "tree-mismatch"] as const)(
    "случай 5: %s даёт failed, затем code и снова show",
    (kind) => {
      const delivering = atDeliver("tree1");
      const failed = apply(delivering, {
        type: "commit-result",
        stageRunID: runID(delivering),
        kind,
        output: "lint: error",
      });
      expect(stageOf(failed.state)).toBe("code");
      expect(failed.state.retries).toEqual({ code: 1 });

      const reported = report(failed.state, "passed");
      expect(kinds(reported.intents)).toEqual(["snapshot-tree"]);
      if (kind === "hook-rejected") {
        expect(failed.intents.find((intent) => intent.kind === "send-prompt")).toMatchObject({
          text: expect.stringContaining("lint: error"),
        });
      }
    },
  );

  test("успешный коммит завершает задачу и удаляет worktree", () => {
    const delivering = atDeliver("tree1");
    const done = apply(delivering, {
      type: "commit-result",
      stageRunID: runID(delivering),
      kind: "ok",
    });
    expect(done.state.status).toBe("done");
    expect(kinds(done.intents)).toEqual(["remove-worktree", "notify-lead"]);
  });

  test("случай 6: ответ на закрытый вопрос или с разошедшимся деревом отклоняется", () => {
    const showing = atShow("tree1");
    const questionID = showing.question?.id ?? "";

    expect(
      decide(showing, { type: "answered", questionID, choice: "approve", tree: "tree0" }),
    ).toMatchObject({ ok: false });
    const approved = apply(showing, {
      type: "answered",
      questionID,
      choice: "approve",
      tree: "tree1",
    }).state;
    expect(
      decide(approved, { type: "answered", questionID, choice: "approve", tree: "tree1" }),
    ).toMatchObject({ ok: false });
  });

  test.each([
    ["queued", () => makeTask()],
    ["active", () => startedTask()],
    ["waiting", () => atShow()],
  ])("случай 7: stop из %s даёт stopped, worktree не удаляется", (status, build) => {
    const state = build();
    expect(state.status).toBe(status);

    const stopped = apply(state, { type: "stop-requested" });
    expect(stopped.state.status).toBe("stopped");
    expect(kinds(stopped.intents)).not.toContain("remove-worktree");
    if (state.sessionReady) expect(kinds(stopped.intents)).toContain("abort-session");
  });

  test("случай 8: коллизия ID сессии даёт blocked без задания, новая попытка берёт новую сессию в том же worktree", () => {
    const granted = apply(makeTask(), { type: "slot-granted" }).state;
    const blocked = apply(granted, {
      type: "session-collision",
      attempt: 1,
      detail: "другой каталог",
    });
    expect(blocked.state.status).toBe("blocked");
    expect(kinds(blocked.intents)).not.toContain("send-prompt");

    const retry = apply(blocked.state, {
      type: "answered",
      questionID: blocked.state.question?.id ?? "",
      choice: "retry",
    });
    expect(retry.state.attempt).toBe(2);
    expect(retry.state.sessionID).not.toBe(granted.sessionID);
    expect(retry.intents.find((intent) => intent.kind === "ensure-worktree")).toMatchObject({
      path: granted.worktreePath,
    });
  });

  test("случай 9: отказ намерения даёт blocked с причиной, уведомление об этом блокировку не вызывает", () => {
    const started = startedTask();
    const blocked = apply(started, {
      type: "intent-failed",
      intent: "send-prompt",
      error: "ECONNREFUSED",
    }).state;
    expect(blocked.status).toBe("blocked");
    expect(blocked.question).toMatchObject({
      kind: "blocked",
      reason: "send-prompt: ECONNREFUSED",
    });

    expect(
      apply(started, { type: "intent-failed", intent: "notify-lead", error: "x" }).state.status,
    ).toBe("active");
  });

  test("случай 10: escalate на code предлагает next, на deliver нет", () => {
    expect(report(startedTask(), "stuck").state.question).toMatchObject({
      options: ["repeat", "next", "stop"],
    });

    const showing = atShow("tree1");
    const onDeliver = apply(
      { ...showing, tree: "tree2" },
      {
        type: "answered",
        questionID: showing.question?.id ?? "",
        choice: "approve",
        tree: "tree1",
      },
    ).state;
    expect(stageOf(onDeliver)).toBe("deliver");
    expect(onDeliver.question).toMatchObject({ kind: "escalate", options: ["repeat", "stop"] });
  });

  test("отчёт чужого прохода и события завершённой задачи отклоняются", () => {
    const started = startedTask();
    expect(
      decide(started, {
        type: "stage-reported",
        stageRunID: "t1-r99",
        outcome: "passed",
        summary: "",
      }),
    ).toMatchObject({ ok: false });

    const stopped = apply(started, { type: "stop-requested" }).state;
    expect(
      decide(stopped, {
        type: "stage-reported",
        stageRunID: runID(started),
        outcome: "passed",
        summary: "",
      }),
    ).toMatchObject({
      ok: false,
    });
  });

  test("ход без отчёта даёт stuck, простой прерывает сессию", () => {
    const started = startedTask();
    const noReport = apply(started, {
      type: "turn-ended-without-report",
      stageRunID: runID(started),
      detail: "idle",
    }).state;
    expect(noReport.question).toMatchObject({
      kind: "escalate",
      reason: expect.stringContaining("без stage_report"),
    });

    const stalled = apply(startedTask(), { type: "stalled", stageRunID: runID(started) });
    expect(kinds(stalled.intents)[0]).toBe("abort-session");
  });
});
