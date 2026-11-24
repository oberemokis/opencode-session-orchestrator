import { z } from "zod";
import { hashText } from "./ids.js";
import { describeIssue } from "./issue.js";
import type { Result } from "./result.js";

export const STAGE_KINDS = ["code", "show", "deliver"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

const OUTCOME_KEYS = {
  code: ["passed", "stuck", "stalled"],
  show: ["passed", "changes-requested"],
  deliver: ["passed", "failed"],
} as const satisfies Record<StageKind, readonly string[]>;

export type Outcome = (typeof OUTCOME_KEYS)[StageKind][number];

/** What a stage does after an outcome, as the code and the stored task state see it. */
const StoredActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("next") }),
  z.strictObject({ kind: z.literal("repeat") }),
  z.strictObject({ kind: z.literal("stop") }),
  z.strictObject({ kind: z.literal("escalate") }),
  z.strictObject({ kind: z.literal("goto"), stageID: z.string() }),
  z.strictObject({ kind: z.literal("goto-previous-code") }),
]);

export type Action = z.infer<typeof StoredActionSchema>;

const ACTION_PATTERN = /^(next|repeat|stop|escalate|goto:[A-Za-z0-9_-]+)$/;
const GOTO_PREFIX = "goto:";

/** The text already matched ACTION_PATTERN, so anything but the four keywords is a goto. */
function parseAction(text: string): Action {
  switch (text) {
    case "next":
    case "repeat":
    case "stop":
    case "escalate":
      return { kind: text };
    default:
      return { kind: "goto", stageID: text.slice(GOTO_PREFIX.length) };
  }
}

/** The route file spells an action as a string. */
const FileActionSchema = z
  .string()
  .regex(ACTION_PATTERN, "ожидается next, repeat, stop, escalate или goto:<id>")
  .transform(parseAction);

const ModelSchema = z.strictObject({
  providerID: z.string().min(1),
  id: z.string().min(1),
  variant: z.string().min(1).optional(),
});

/** The route file and the stored task state share one shape; only the spelling of actions differs. */
function buildWorkflowSchema(actionSchema: z.ZodType<Action>) {
  const stage = z.strictObject({
    id: z.string().regex(/^[A-Za-z0-9_-]+$/),
    uses: z.enum(STAGE_KINDS),
    model: ModelSchema.optional(),
    instructions: z.string().optional(),
    on: z.record(z.string(), actionSchema).optional(),
    limits: z
      .strictObject({
        retries: z.int().min(0).optional(),
        stallMinutes: z.int().min(1).optional(),
      })
      .optional(),
    delivery: z.strictObject({ type: z.literal("local-commit") }).optional(),
  });

  return z.strictObject({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    stages: z.array(stage).min(1),
  });
}

const FileWorkflowSchema = buildWorkflowSchema(FileActionSchema);

export const StoredWorkflowSchema = buildWorkflowSchema(StoredActionSchema);

export type ModelRef = z.infer<typeof ModelSchema>;
export type Workflow = z.infer<typeof StoredWorkflowSchema>;
export type Stage = Workflow["stages"][number];

export type ParseResult<Value> = Result<{ readonly value: Value; readonly hash: string }>;

export const DEFAULT_RETRIES = 2;
export const DEFAULT_STALL_MINUTES = 30;

export function parseWorkflow(raw: unknown): ParseResult<Workflow> {
  const parsed = FileWorkflowSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: describeIssue(parsed.error) };

  const workflow = parsed.data;
  const problem = findRouteProblem(workflow);
  if (problem) return { ok: false, error: problem };

  return { ok: true, value: workflow, hash: hashText(JSON.stringify(workflow)) };
}

function findRouteProblem(workflow: Workflow): string | undefined {
  const ids = new Set<string>();

  for (const [index, stage] of workflow.stages.entries()) {
    const at = `stages.${index}`;
    if (ids.has(stage.id)) return `${at}.id: этап «${stage.id}» уже есть`;
    ids.add(stage.id);

    if (stage.uses === "deliver" && !stage.delivery)
      return `${at}.delivery: у deliver нужен delivery`;
    if (stage.uses !== "deliver" && stage.delivery)
      return `${at}.delivery: delivery бывает только у deliver`;
  }

  for (const [index, stage] of workflow.stages.entries()) {
    const at = `stages.${index}`;
    const allowed: readonly string[] = OUTCOME_KEYS[stage.uses];

    for (const [outcome, action] of Object.entries(stage.on ?? {})) {
      if (!allowed.includes(outcome))
        return `${at}.on.${outcome}: у ${stage.uses} нет исхода ${outcome}`;
      if (action.kind !== "goto") continue;

      const target = action.stageID;
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
