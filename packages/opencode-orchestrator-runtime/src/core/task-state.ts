import { z } from "zod";
import { ProjectConfigSchema } from "./project-config.js";
import { StoredWorkflowSchema } from "./workflow.js";

export const TASK_STATUSES = ["queued", "active", "waiting", "blocked", "done", "stopped"] as const;

const RUN_PHASES = ["working", "snapshot", "asking", "committing"] as const;

const StageRunSchema = z
  .strictObject({
    id: z.string(),
    stageID: z.string(),
    phase: z.enum(RUN_PHASES),
    feedback: z.string().nullable(),
  })
  .readonly();

const QuestionSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      id: z.string(),
      kind: z.literal("show"),
      stageRunID: z.string(),
      tree: z.string(),
    }),
    z.strictObject({
      id: z.string(),
      kind: z.literal("escalate"),
      stageRunID: z.string().nullable(),
      reason: z.string(),
      options: z.array(z.enum(["repeat", "next", "stop"])).readonly(),
    }),
    z.strictObject({ id: z.string(), kind: z.literal("blocked"), reason: z.string() }),
  ])
  .readonly();

/** The shape of a task as it is stored in SQLite and read back; the types of the core derive from it. */
export const TaskStateSchema = z
  .strictObject({
    id: z.string(),
    salt: z.string(),
    text: z.string(),
    sourceSessionID: z.string(),
    sourceDirectory: z.string(),
    projectDir: z.string(),
    worktreePath: z.string(),
    branch: z.string(),
    baseCommit: z.string(),
    workflow: StoredWorkflowSchema,
    workflowHash: z.string(),
    config: ProjectConfigSchema,
    status: z.enum(TASK_STATUSES),
    stageIndex: z.number(),
    attempt: z.number(),
    sessionID: z.string().nullable(),
    sessionReady: z.boolean(),
    run: StageRunSchema.nullable(),
    runSeq: z.number(),
    retries: z.record(z.string(), z.number()).readonly(),
    tree: z.string().nullable(),
    reviewedTree: z.string().nullable(),
    question: QuestionSchema.nullable(),
    questionSeq: z.number(),
    noteSeq: z.number(),
    summary: z.string().nullable(),
  })
  .readonly();
