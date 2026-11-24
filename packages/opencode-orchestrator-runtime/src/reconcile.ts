import type { SessionMessage, ToolPart } from "./opencode.js";

export interface StageReport {
  readonly outcome: "passed" | "stuck";
  readonly summary: string;
}

export type TurnReading =
  | { readonly kind: "not-delivered" }
  | { readonly kind: "running" }
  | { readonly kind: "ended"; readonly report: StageReport | null; readonly detail: string };

/**
 * Reads the worker's turn that started with our prompt.
 * The turn ends with an `idle` message that is not followed by a restart notice:
 * after `notice: "restart"` the server continues the turn on its own, so the session is still busy.
 * The last non-empty `stage_report` of this stage run wins, whatever the call status.
 */
export function readTurn(messages: readonly SessionMessage[], promptID: string, stageRunID: string): TurnReading {
  const start = messages.findIndex((message) => message.id === promptID);
  if (start === -1) return { kind: "not-delivered" };

  const after = messages.slice(start + 1);
  let lastIdle = -1;
  let lastRestart = -1;
  let report: StageReport | null = null;

  for (const [index, message] of after.entries()) {
    if (message.type === "idle") lastIdle = index;
    if (message.type === "synthetic" && message.metadata?.notice === "restart") lastRestart = index;
    if (message.type === "user") break;
    if (message.type !== "assistant") continue;

    for (const part of message.content ?? []) {
      const found = toReport(part, stageRunID);
      if (found) report = found;
    }
  }

  if (lastIdle === -1 || lastIdle < lastRestart) return { kind: "running" };

  const idle = after[lastIdle];
  const detail = idle?.error?.message ? `idle ${idle.outcome}: ${idle.error.message}` : `idle ${idle?.outcome ?? "?"}`;
  return { kind: "ended", report, detail };
}

function toReport(part: { readonly type: string }, stageRunID: string): StageReport | null {
  if (!isToolPart(part) || part.name !== "stage_report") return null;

  const input = part.state.input;
  if (typeof input !== "object" || input === null) return null;

  const { stageRunID: reportedRun, outcome, summary } = input as Record<string, unknown>;
  if (reportedRun !== stageRunID) return null;
  if (outcome !== "passed" && outcome !== "stuck") return null;
  return { outcome, summary: typeof summary === "string" ? summary : "" };
}

function isToolPart(part: { readonly type: string }): part is ToolPart {
  return part.type === "tool" && "name" in part && "state" in part;
}
