import { buildSessionPermissions } from "./core/permissions.js";
import type { Intent, TaskEvent, TaskState } from "./core/types.js";
import type { ModelRef } from "./core/workflow.js";
import {
  commitReviewedTree,
  ensureWorktree,
  prepareWorktree,
  removeWorktree,
  snapshotTree,
} from "./git.js";
import { type OpenCodeClient, OpenCodeError } from "./opencode.js";
import type { SessionInfo } from "./opencode-schemas.js";
import { PermanentError } from "./permanent-error.js";

export const WORKER_AGENT = "orchestrator-worker";

export interface ExecuteContext {
  readonly opencode: OpenCodeClient;
  readonly task: TaskState;
}

/** Runs one intent. Returns the event its result produces, if any. Throws PermanentError when retrying cannot help. */
export async function executeIntent(
  intent: Intent,
  context: ExecuteContext,
): Promise<TaskEvent | undefined> {
  const { opencode, task } = context;

  try {
    switch (intent.kind) {
      case "ensure-worktree":
        await ensureWorktree({
          projectDir: task.projectDir,
          path: intent.path,
          branch: intent.branch,
          base: intent.base,
        });
        return undefined;

      case "prepare-worktree":
        await prepareWorktree({
          projectDir: intent.projectDir,
          path: intent.path,
          copy: intent.copy,
          command: intent.command,
        });
        return undefined;

      case "create-session":
        return await createSession(intent, context);

      case "switch-model":
        await switchModel(intent.sessionID, intent.model, context);
        return undefined;

      case "send-prompt":
        await opencode.prompt(intent.sessionID, task.worktreePath, {
          id: intent.messageID,
          text: intent.text,
        });
        return undefined;

      case "notify-lead":
        await opencode.note(intent.sessionID, intent.directory, {
          id: intent.messageID,
          text: intent.text,
        });
        return undefined;

      case "abort-session":
        await opencode.interrupt(intent.sessionID, task.worktreePath);
        return undefined;

      case "snapshot-tree":
        return {
          type: "tree-snapshotted",
          stageRunID: intent.stageRunID,
          tree: await snapshotTree(intent.path),
        };

      case "commit": {
        const result = await commitReviewedTree({
          path: intent.path,
          base: intent.base,
          tree: intent.tree,
          message: intent.message,
        });
        return {
          type: "commit-result",
          stageRunID: intent.stageRunID,
          kind: result.kind,
          output: "output" in result ? result.output : undefined,
        };
      }

      case "remove-worktree":
        await removeWorktree(task.projectDir, intent.path);
        return undefined;
    }
  } catch (error) {
    if (
      error instanceof OpenCodeError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 429
    ) {
      throw new PermanentError(error.message);
    }
    throw error;
  }
}

/** OpenCode does not validate the model it is given, so the runtime checks it before and after. */
async function switchModel(
  sessionID: string,
  model: ModelRef,
  context: ExecuteContext,
): Promise<void> {
  const { opencode, task } = context;
  const label = `${model.providerID}/${model.id}`;

  const models = await opencode.models(task.worktreePath);
  const known = models.some(
    (candidate) => candidate.providerID === model.providerID && candidate.id === model.id,
  );
  if (!known) throw new PermanentError(`модели ${label} нет в OpenCode`);

  await opencode.switchModel(sessionID, task.worktreePath, model);
  const session = await opencode.session(sessionID, task.worktreePath);
  if (session?.model?.providerID !== model.providerID || session.model.id !== model.id) {
    throw new Error(`сессия ${sessionID} не переключилась на ${label}`);
  }
}

async function createSession(
  intent: Extract<Intent, { kind: "create-session" }>,
  context: ExecuteContext,
): Promise<TaskEvent> {
  const { opencode, task } = context;
  const metadata = { orchestratorTask: task.id, attempt: intent.attempt };

  const existing = await opencode.session(intent.sessionID, intent.directory);
  if (existing) return verifySession(existing, intent, metadata);

  // A fresh location loads plugins after its first request, so a missing agent is polled
  // before it becomes a block: the plugin may still be loading, or not be configured at all.
  if (!(await waitForAgent(opencode, intent.directory))) {
    throw new Error(
      `агента ${WORKER_AGENT} нет в ${intent.directory}: плагин opencode-orchestrator ещё грузится или не подключён в глобальном конфиге OpenCode`,
    );
  }

  const permissions = buildSessionPermissions({
    projectDeny: intent.deny,
    mcpServers: await opencode.mcpServers(intent.directory),
    mcpRead: intent.mcpRead,
  });
  await opencode.createSession({
    id: intent.sessionID,
    directory: intent.directory,
    agent: WORKER_AGENT,
    title: intent.title,
    metadata,
    permissions,
  });

  // POST with an existing id silently returns that session, so the result is checked, not trusted.
  const created = await opencode.session(intent.sessionID, intent.directory);
  if (!created) throw new Error(`сессия ${intent.sessionID} не появилась после создания`);
  return verifySession(created, intent, metadata);
}

const AGENT_WAIT_MS = 30_000;
const AGENT_POLL_MS = 1_000;

async function waitForAgent(opencode: OpenCodeClient, directory: string): Promise<boolean> {
  const deadline = Date.now() + AGENT_WAIT_MS;
  for (;;) {
    if (await opencode.agentExists(WORKER_AGENT, directory)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, AGENT_POLL_MS));
  }
}

function verifySession(
  session: SessionInfo,
  intent: Extract<Intent, { kind: "create-session" }>,
  metadata: { orchestratorTask: string; attempt: number },
): TaskEvent {
  const problems: string[] = [];
  if (session.location.directory !== intent.directory)
    problems.push(`каталог ${session.location.directory}`);
  if (
    session.metadata?.orchestratorTask !== metadata.orchestratorTask ||
    session.metadata?.attempt !== metadata.attempt
  ) {
    problems.push(`metadata ${JSON.stringify(session.metadata ?? {})}`);
  }
  if (session.agent !== WORKER_AGENT) problems.push(`агент ${session.agent ?? "нет"}`);

  if (problems.length > 0)
    return {
      type: "session-collision",
      attempt: intent.attempt,
      detail: problems.join(", "),
    };
  return { type: "session-confirmed", attempt: intent.attempt };
}
