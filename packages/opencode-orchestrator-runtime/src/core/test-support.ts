import { decide } from "./decide.js";
import { parseProjectConfig } from "./project-config.js";
import { createTask } from "./task.js";
import type { Intent, TaskEvent, TaskState } from "./types.js";
import { parseWorkflow } from "./workflow.js";

export const DEFAULT_ROUTE = {
  schemaVersion: 1,
  id: "default",
  stages: [
    { id: "code", uses: "code" },
    { id: "show", uses: "show" },
    { id: "deliver", uses: "deliver", delivery: { type: "local-commit" }, on: { failed: "goto:code" } },
  ],
};

export function makeTask(route: unknown = DEFAULT_ROUTE): TaskState {
  const workflow = parseWorkflow(route);
  const config = parseProjectConfig({});
  if (!workflow.ok) throw new Error(workflow.error);
  if (!config.ok) throw new Error(config.error);

  return createTask({
    id: "t1",
    salt: "salt",
    text: "Добавь README",
    sourceSessionID: "ses_lead",
    sourceDirectory: "/repo",
    projectDir: "/repo",
    baseCommit: "base0",
    workflow: workflow.value,
    workflowHash: workflow.hash,
    config: config.value,
  });
}

export interface Trace {
  readonly state: TaskState;
  readonly intents: readonly Intent[];
}

/** Applies events in order and fails loudly on the first rejection. */
export function apply(state: TaskState, ...events: readonly TaskEvent[]): Trace {
  let current = state;
  const intents: Intent[] = [];

  for (const event of events) {
    const decision = decide(current, event);
    if (!decision.ok) throw new Error(`${event.type} rejected: ${decision.reject}`);
    current = decision.state;
    intents.push(...decision.intents);
  }
  return { state: current, intents };
}

export function startedTask(route?: unknown): TaskState {
  return apply(makeTask(route), { type: "slot-granted" }, { type: "session-confirmed", attempt: 1 }).state;
}

export function runID(state: TaskState): string {
  if (!state.run) throw new Error("no active stage run");
  return state.run.id;
}

export function kinds(intents: readonly Intent[]): string[] {
  return intents.map((intent) => intent.kind);
}

/** code passes, show snapshots tree `tree` and the question is open. */
export function atShow(tree = "tree1", route?: unknown): TaskState {
  const coding = startedTask(route);
  const passed = apply(coding, { type: "stage-reported", stageRunID: runID(coding), outcome: "passed", summary: "ok" });
  return apply(passed.state, { type: "tree-snapshotted", stageRunID: runID(passed.state), tree }).state;
}

export function atDeliver(tree = "tree1"): TaskState {
  const showing = atShow(tree);
  const questionID = showing.question?.id ?? "";
  return apply(showing, { type: "answered", questionID, choice: "approve", tree }).state;
}
