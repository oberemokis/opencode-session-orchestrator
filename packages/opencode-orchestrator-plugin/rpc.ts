import { z } from "zod";

/** Shared by the server part (handlers) and the TUI part (client). */

const FileChange = z.object({
  path: z.string(),
  additions: z.number(),
  deletions: z.number(),
  sensitive: z.boolean(),
  patch: z.string(),
});

export const QuestionView = z.object({
  questionID: z.string(),
  taskID: z.string(),
  kind: z.enum(["show", "escalate", "blocked"]),
  text: z.string(),
  stage: z.string().nullable(),
  reason: z.string().nullable(),
  options: z.array(z.string()),
  tree: z.string().nullable(),
  files: z.array(FileChange),
});
export type QuestionView = z.infer<typeof QuestionView>;

export const TaskSummary = z.object({
  id: z.string(),
  status: z.string(),
  stage: z.string().nullable(),
  text: z.string(),
  branch: z.string(),
  worktree: z.string(),
  question: z.string().nullable(),
});
export type TaskSummary = z.infer<typeof TaskSummary>;

const AnswerResult = z.object({ ok: z.boolean(), error: z.string().optional(), status: z.string().optional() });

export const orchestratorRpc = {
  id: "opencode-orchestrator",
  methods: {
    questions: {
      input: z.object({}),
      output: z.object({ available: z.boolean(), questions: z.array(QuestionView) }),
    },
    status: {
      input: z.object({}),
      output: z.object({ available: z.boolean(), tasks: z.array(TaskSummary) }),
    },
    answer: {
      input: z.object({
        commandID: z.string(),
        questionID: z.string(),
        choice: z.string(),
        text: z.string().optional(),
        tree: z.string().optional(),
      }),
      output: AnswerResult,
    },
  },
  events: {},
} as const;
