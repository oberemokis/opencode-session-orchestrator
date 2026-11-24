import { z } from "zod";
import { ANSWER_CHOICES } from "./core/types.js";

/** What runtime methods answer. The server builds these shapes, the CLI and the plugin parse them. */

export const FileChangeSchema = z.object({
  path: z.string(),
  additions: z.number(),
  deletions: z.number(),
  sensitive: z.boolean(),
  patch: z.string(),
});

export const TaskSummarySchema = z.object({
  id: z.string(),
  status: z.string(),
  stage: z.string().nullable(),
  text: z.string(),
  branch: z.string(),
  worktree: z.string(),
  question: z.string().nullable(),
});

export const QuestionViewSchema = z.object({
  questionID: z.string(),
  taskID: z.string(),
  kind: z.enum(["show", "escalate", "blocked"]),
  text: z.string(),
  stage: z.string().nullable(),
  reason: z.string().nullable(),
  options: z.array(z.enum(ANSWER_CHOICES)),
  tree: z.string().nullable(),
  files: z.array(FileChangeSchema),
});

export const StatusReplySchema = z.object({ tasks: z.array(TaskSummarySchema) });

export const QuestionsReplySchema = z.object({ questions: z.array(QuestionViewSchema) });

/** Reply to task.start, task.stop and question.answer. */
export const CommandReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), taskID: z.string(), status: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type TaskSummary = z.infer<typeof TaskSummarySchema>;
export type QuestionView = z.infer<typeof QuestionViewSchema>;
export type CommandReply = z.infer<typeof CommandReplySchema>;
