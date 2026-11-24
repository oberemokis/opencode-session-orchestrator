import { QuestionViewSchema, TaskSummarySchema } from "opencode-orchestrator-runtime/rpc-contract";
import { z } from "zod";

/** Shared by the server part (handlers) and the TUI part (client). The shapes come from the runtime. */

export type { QuestionView, TaskSummary } from "opencode-orchestrator-runtime/rpc-contract";

const AnswerResult = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  status: z.string().optional(),
});

export const orchestratorRpc = {
  id: "opencode-orchestrator",
  methods: {
    questions: {
      input: z.object({}),
      output: z.object({ available: z.boolean(), questions: z.array(QuestionViewSchema) }),
    },
    status: {
      input: z.object({}),
      output: z.object({ available: z.boolean(), tasks: z.array(TaskSummarySchema) }),
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
