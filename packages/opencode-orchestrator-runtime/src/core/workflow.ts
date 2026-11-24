import { z } from "zod";
import { hashText } from "./ids.js";

export const STAGE_KINDS = ["code", "show", "deliver"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

const OUTCOME_KEYS = {
  code: ["passed", "stuck", "stalled"],
  show: ["passed", "changes-requested"],
  deliver: ["passed", "failed"],
} as const satisfies Record<StageKind, readonly string[]>;

const ACTION_PATTERN = /^(next|repeat|stop|escalate|goto:[A-Za-z0-9_-]+)$/;

const ModelSchema = z.strictObject({
  providerID: z.string().min(1),
  id: z.string().min(1),
  variant: z.string().min(1).optional(),
});

const StageSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  uses: z.enum(STAGE_KINDS),
  model: ModelSchema.optional(),
  instructions: z.string().optional(),
  on: z.record(z.string(), z.string().regex(ACTION_PATTERN, "ожидается next, repeat, stop, escalate или goto:<id>")).optional(),
  limits: z
    .strictObject({
      retries: z.int().min(0).optional(),
      stallMinutes: z.int().min(1).optional(),
    })
    .optional(),
  delivery: z.strictObject({ type: z.literal("local-commit") }).optional(),
});

const WorkflowSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  stages: z.array(StageSchema).min(1),
});

export type ModelRef = z.infer<typeof ModelSchema>;
export type Stage = z.infer<typeof StageSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;

export type ParseResult<Value> = { ok: true; value: Value; hash: string } | { ok: false; error: string };

export const DEFAULT_RETRIES = 2;
export const DEFAULT_STALL_MINUTES = 30;

export function parseWorkflow(raw: unknown): ParseResult<Workflow> {
  const parsed = WorkflowSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: formatIssue(parsed.error.issues[0]) };

  const workflow = parsed.data;
  const problem = findRouteProblem(workflow);
  if (problem) return { ok: false, error: problem };

  return { ok: true, value: workflow, hash: hashText(JSON.stringify(workflow)) };
}

function formatIssue(issue: z.core.$ZodIssue | undefined): string {
  if (!issue) return "маршрут не прошёл проверку";

  const path = issue.path.map(String).join(".") || "(корень)";
  if (issue.code === "unrecognized_keys") return `${path}: неизвестное поле ${issue.keys.join(", ")}`;
  return `${path}: ${issue.message}`;
}

function findRouteProblem(workflow: Workflow): string | undefined {
  const ids = new Set<string>();

  for (const [index, stage] of workflow.stages.entries()) {
    const at = `stages.${index}`;
    if (ids.has(stage.id)) return `${at}.id: этап «${stage.id}» уже есть`;
    ids.add(stage.id);

    if (stage.uses === "deliver" && !stage.delivery) return `${at}.delivery: у deliver нужен delivery`;
    if (stage.uses !== "deliver" && stage.delivery) return `${at}.delivery: delivery бывает только у deliver`;
  }

  for (const [index, stage] of workflow.stages.entries()) {
    const at = `stages.${index}`;
    const allowed: readonly string[] = OUTCOME_KEYS[stage.uses];

    for (const [outcome, action] of Object.entries(stage.on ?? {})) {
      if (!allowed.includes(outcome)) return `${at}.on.${outcome}: у ${stage.uses} нет исхода ${outcome}`;
      if (!action.startsWith("goto:")) continue;

      const target = action.slice("goto:".length);
      const targetStage = workflow.stages.find((candidate) => candidate.id === target);
      if (!targetStage) return `${at}.on.${outcome}: этапа «${target}» нет`;
      if (targetStage.uses === "deliver" && stage.uses !== "show") {
        return `${at}.on.${outcome}: в deliver можно перейти только из show`;
      }
    }

    if (stage.uses === "deliver" && !hasShowRightBefore(workflow, index)) {
      return `${at}: перед deliver нужен show без правящих этапов между ними`;
    }
  }

  return undefined;
}

function hasShowRightBefore(workflow: Workflow, deliverIndex: number): boolean {
  for (let index = deliverIndex - 1; index >= 0; index--) {
    const kind = workflow.stages[index]?.uses;
    if (kind === "show") return true;
    if (kind === "code") return false;
  }
  return false;
}

export function stageRetries(stage: Stage): number {
  return stage.limits?.retries ?? DEFAULT_RETRIES;
}

export function stageStallMinutes(stage: Stage): number {
  return stage.limits?.stallMinutes ?? DEFAULT_STALL_MINUTES;
}
