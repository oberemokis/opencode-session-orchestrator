import type { z } from "zod";

/** One line for the first problem zod found: where it is and what is wrong. */
export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "не прошло проверку";

  const path = issue.path.map(String).join(".") || "(корень)";
  if (issue.code === "unrecognized_keys")
    return `${path}: неизвестное поле ${issue.keys.join(", ")}`;
  return `${path}: ${issue.message}`;
}
