import { z } from "zod";
import { hashText } from "./ids.js";
import type { ParseResult } from "./workflow.js";

const ProjectConfigSchema = z.strictObject({
  base: z.string().min(1).default("HEAD"),
  branchPrefix: z
    .string()
    .regex(/^[A-Za-z0-9._/-]+$/)
    .default("orchestrator"),
  setup: z
    .strictObject({
      copy: z.array(z.string().min(1)).default([]),
      command: z.string().min(1).optional(),
    })
    .default({ copy: [] }),
  deny: z.array(z.string().min(1)).default([]),
  mcpRead: z.array(z.string().regex(/^[^\s]+_[^\s]+$/, "ожидается <сервер>_<инструмент>")).default([]),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export function parseProjectConfig(raw: unknown): ParseResult<ProjectConfig> {
  const parsed = ProjectConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.map(String).join(".") || "(корень)";
    const detail = issue?.code === "unrecognized_keys" ? `неизвестное поле ${issue.keys.join(", ")}` : issue?.message;
    return { ok: false, error: `${path}: ${detail ?? "конфиг не прошёл проверку"}` };
  }

  for (const path of parsed.data.setup.copy) {
    if (path.startsWith("/") || path.split("/").includes("..")) {
      return { ok: false, error: `setup.copy: путь «${path}» должен лежать внутри проекта` };
    }
  }

  return { ok: true, value: parsed.data, hash: hashText(JSON.stringify(parsed.data)) };
}
