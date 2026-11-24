import { describe, expect, test } from "vitest";
import { parseProjectConfig } from "./project-config.js";
import { DEFAULT_ROUTE } from "./test-support.js";
import { parseWorkflow } from "./workflow.js";

function route(stages: unknown[], extra: Record<string, unknown> = {}) {
  return { schemaVersion: 1, id: "r", stages, ...extra };
}

const deliver = { id: "deliver", uses: "deliver", delivery: { type: "local-commit" } };

describe("загрузчик маршрута", () => {
  test("принимает маршрут первой поставки", () => {
    expect(parseWorkflow(DEFAULT_ROUTE)).toMatchObject({ ok: true });
  });

  test.each([
    [
      "неизвестное поле этапа",
      route([{ id: "code", uses: "code", when: {} }]),
      "stages.0: неизвестное поле when",
    ],
    [
      "неизвестное поле корня",
      route([{ id: "code", uses: "code" }], { models: {} }),
      "(корень): неизвестное поле models",
    ],
    [
      "goto на отсутствующий этап",
      route([{ id: "code", uses: "code", on: { stuck: "goto:plan" } }]),
      "stages.0.on.stuck: этапа «plan» нет",
    ],
    ["неизвестный вид этапа", route([{ id: "r", uses: "research" }]), "stages.0.uses"],
    [
      "повтор id",
      route([
        { id: "code", uses: "code" },
        { id: "code", uses: "code" },
      ]),
      "stages.1.id: этап «code» уже есть",
    ],
    [
      "исход, которого нет у вида",
      route([{ id: "code", uses: "code", on: { failed: "next" } }]),
      "stages.0.on.failed: у code нет исхода failed",
    ],
    [
      "deliver без show перед ним",
      route([{ id: "code", uses: "code" }, deliver]),
      "stages.1: перед deliver нужен show",
    ],
    [
      "правящий этап между show и deliver",
      route([{ id: "show", uses: "show" }, { id: "code", uses: "code" }, deliver]),
      "stages.2: перед deliver нужен show",
    ],
    [
      "действие не из списка",
      route([{ id: "code", uses: "code", on: { passed: "launch" } }]),
      "stages.0.on.passed",
    ],
    [
      "действие объектом вместо строки",
      route([{ id: "code", uses: "code", on: { passed: { kind: "next" } } }]),
      "stages.0.on.passed",
    ],
  ])("случай 11: отклоняет: %s, с путём к полю", (_name, input, expected) => {
    const result = parseWorkflow(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(expected);
  });

  test("случай 40: строки действий из файла становятся типизированными действиями", () => {
    const parsed = parseWorkflow(
      route([
        { id: "code", uses: "code", on: { stuck: "goto:code", passed: "stop", stalled: "repeat" } },
      ]),
    );

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        stages: [
          {
            on: {
              stuck: { kind: "goto", stageID: "code" },
              passed: { kind: "stop" },
              stalled: { kind: "repeat" },
            },
          },
        ],
      },
    });
  });

  test("случай 4: goto:deliver разрешён только из show", () => {
    const fromCode = route([
      { id: "code", uses: "code", on: { passed: "goto:deliver" } },
      { id: "show", uses: "show" },
      deliver,
    ]);
    const fromShow = route([
      { id: "code", uses: "code" },
      { id: "show", uses: "show", on: { passed: "goto:deliver" } },
      deliver,
    ]);

    expect(parseWorkflow(fromCode)).toMatchObject({
      ok: false,
      error: expect.stringContaining("stages.0.on.passed"),
    });
    expect(parseWorkflow(fromShow)).toMatchObject({ ok: true });
  });
});

describe("конфиг проекта", () => {
  test("без файла даёт умолчания", () => {
    expect(parseProjectConfig(undefined)).toMatchObject({
      ok: true,
      value: {
        base: "HEAD",
        branchPrefix: "orchestrator",
        setup: { copy: [] },
        deny: [],
        mcpRead: [],
      },
    });
  });

  test("отклоняет путь копирования за пределы проекта и неизвестное поле", () => {
    expect(parseProjectConfig({ setup: { copy: ["../secret"] } })).toMatchObject({ ok: false });
    expect(parseProjectConfig({ hooks: true })).toMatchObject({
      ok: false,
      error: "(корень): неизвестное поле hooks",
    });
  });
});
