import { z } from "zod";

/**
 * Only the fields the runtime reads are described, and unknown fields are allowed:
 * OpenCode may add data, but a missing or retyped field must stop us instead of spreading as undefined.
 */

export const SessionInfoSchema = z.looseObject({
  id: z.string(),
  agent: z.string().nullish(),
  model: z
    .looseObject({ providerID: z.string(), id: z.string(), variant: z.string().nullish() })
    .nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  location: z.looseObject({ directory: z.string() }),
  time: z.looseObject({ created: z.number(), updated: z.number() }),
});

export const ToolPartSchema = z.looseObject({
  type: z.literal("tool"),
  id: z.string(),
  name: z.string(),
  state: z.looseObject({
    status: z.string(),
    input: z.unknown().optional(),
    error: z.unknown().optional(),
  }),
});

export const SessionMessageSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  outcome: z.string().nullish(),
  error: z.looseObject({ type: z.string().nullish(), message: z.string().nullish() }).nullish(),
  content: z.array(z.looseObject({ type: z.string() })).nullish(),
});

/** The runtime re-reads the session after creating it, so only the id of the created one matters. */
export const CreatedSessionReplySchema = z.looseObject({ data: z.looseObject({ id: z.string() }) });

export const InfoReplySchema = z.looseObject({ version: z.string() });
export const SessionReplySchema = z.looseObject({ data: SessionInfoSchema });
export const McpReplySchema = z.looseObject({ data: z.array(z.looseObject({ name: z.string() })) });
export const ModelsReplySchema = z.looseObject({
  data: z.array(z.looseObject({ providerID: z.string(), id: z.string() })),
});
export const MessagesReplySchema = z.looseObject({
  data: z.array(SessionMessageSchema),
  cursor: z.looseObject({ next: z.string().nullish() }).nullish(),
});

export type SessionInfo = z.infer<typeof SessionInfoSchema>;
export type ToolPart = z.infer<typeof ToolPartSchema>;
export type SessionMessage = z.infer<typeof SessionMessageSchema>;
