import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { describeIssue } from "./core/issue.js";
import type { PermissionRule } from "./core/permissions.js";
import type { ModelRef } from "./core/workflow.js";
import {
  CreatedSessionReplySchema,
  InfoReplySchema,
  McpReplySchema,
  MessagesReplySchema,
  ModelsReplySchema,
  type SessionInfo,
  type SessionMessage,
  SessionReplySchema,
} from "./opencode-schemas.js";
import { PermanentError } from "./permanent-error.js";

export interface OpenCodeTarget {
  readonly url: string;
  readonly password: string | null;
}

/** Thrown for answers that a retry cannot change: 4xx other than 404 handled by callers. */
export class OpenCodeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const ServiceFileSchema = z.looseObject({
  url: z.string().optional(),
  password: z.string().optional(),
});

const REQUEST_TIMEOUT_MS = 30_000;
const MESSAGES_PAGE_SIZE = 200;

export function discoverOpenCode(env: NodeJS.ProcessEnv = process.env): OpenCodeTarget {
  if (env.ORCHESTRATOR_OPENCODE_URL) {
    return {
      url: env.ORCHESTRATOR_OPENCODE_URL,
      password: env.ORCHESTRATOR_OPENCODE_PASSWORD ?? null,
    };
  }

  const stateHome = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  const file = join(stateHome, "opencode", "service.json");
  const parsed = ServiceFileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file}: ${describeIssue(parsed.error)}`);

  const service = parsed.data;
  if (!service.url) {
    throw new Error(`в ${file} нет адреса службы OpenCode; запусти opencode serve --service`);
  }
  return { url: service.url, password: service.password ?? null };
}

export class OpenCodeClient {
  readonly #target: OpenCodeTarget;

  constructor(target: OpenCodeTarget) {
    this.#target = target;
  }

  /** Returns undefined for 404 and for an empty body; a body that does not match the schema is permanent. */
  async #request<Schema extends z.ZodType>(input: {
    method: string;
    path: string;
    schema: Schema;
    directory?: string;
    body?: unknown;
  }): Promise<z.infer<Schema> | undefined> {
    const url = new URL(input.path, this.#target.url);
    if (input.directory) url.searchParams.set("location[directory]", input.directory);

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#target.password) {
      headers.authorization = `Basic ${Buffer.from(`opencode:${this.#target.password}`).toString("base64")}`;
    }

    const response = await fetch(url, {
      method: input.method,
      headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    const what = `${input.method} ${url.pathname}`;

    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new OpenCodeError(
        `${what} -> ${response.status}: ${text.slice(0, 300)}`,
        response.status,
      );
    }
    if (!text) return undefined;

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new PermanentError(`${what}: ответ OpenCode не является JSON`);
    }
    const parsed = input.schema.safeParse(raw);
    if (!parsed.success) {
      throw new PermanentError(
        `${what}: ответ OpenCode не совпал со схемой, ${describeIssue(parsed.error)}`,
      );
    }
    return parsed.data;
  }

  async version(): Promise<string> {
    const info = await this.#request({
      method: "GET",
      path: "/api/info",
      schema: InfoReplySchema,
    });
    if (!info) throw new Error("OpenCode не отдал /api/info");
    return info.version;
  }

  async session(id: string, directory: string): Promise<SessionInfo | undefined> {
    const response = await this.#request({
      method: "GET",
      path: `/api/session/${id}`,
      schema: SessionReplySchema,
      directory,
    });
    return response?.data;
  }

  async createSession(input: {
    id: string;
    directory: string;
    agent: string;
    title: string;
    metadata: Record<string, unknown>;
    permissions: readonly PermissionRule[];
  }): Promise<{ id: string }> {
    const response = await this.#request({
      method: "POST",
      path: "/api/session",
      schema: CreatedSessionReplySchema,
      directory: input.directory,
      body: {
        id: input.id,
        location: { directory: input.directory },
        agent: input.agent,
        title: input.title,
        metadata: input.metadata,
        permissions: input.permissions,
      },
    });
    if (!response) throw new Error("OpenCode не вернул созданную сессию");
    return response.data;
  }

  async agentExists(name: string, directory: string): Promise<boolean> {
    const response = await this.#request({
      method: "GET",
      path: `/api/agent/${name}`,
      schema: z.unknown(),
      directory,
    });
    return response !== undefined;
  }

  async mcpServers(directory: string): Promise<string[]> {
    const response = await this.#request({
      method: "GET",
      path: "/api/mcp",
      schema: McpReplySchema,
      directory,
    });
    return (response?.data ?? []).map((server) => server.name);
  }

  async models(directory: string): Promise<ModelRef[]> {
    const response = await this.#request({
      method: "GET",
      path: "/api/model",
      schema: ModelsReplySchema,
      directory,
    });
    return (response?.data ?? []).map((model) => ({ providerID: model.providerID, id: model.id }));
  }

  async switchModel(sessionID: string, directory: string, model: ModelRef): Promise<void> {
    await this.#request({
      method: "POST",
      path: `/api/session/${sessionID}/model`,
      schema: z.unknown(),
      directory,
      body: { model },
    });
  }

  async prompt(
    sessionID: string,
    directory: string,
    message: { id: string; text: string },
  ): Promise<void> {
    const response = await this.#request({
      method: "POST",
      path: `/api/session/${sessionID}/prompt`,
      schema: z.unknown(),
      directory,
      body: message,
    });
    if (response === undefined) throw new OpenCodeError(`сессия ${sessionID} не найдена`, 404);
  }

  async note(
    sessionID: string,
    directory: string,
    message: { id: string; text: string },
  ): Promise<void> {
    const response = await this.#request({
      method: "POST",
      path: `/api/session/${sessionID}/synthetic`,
      schema: z.unknown(),
      directory,
      body: { ...message, description: "opencode-orchestrator", resume: false },
    });
    if (response === undefined) throw new OpenCodeError(`чат ${sessionID} не найден`, 404);
  }

  async interrupt(sessionID: string, directory?: string): Promise<void> {
    await this.#request({
      method: "POST",
      path: `/api/session/${sessionID}/interrupt`,
      schema: z.unknown(),
      ...(directory ? { directory } : {}),
      body: {},
    });
  }

  async deleteSession(sessionID: string): Promise<void> {
    await this.#request({
      method: "DELETE",
      path: `/api/session/${sessionID}`,
      schema: z.unknown(),
    });
  }

  async messages(sessionID: string, directory: string): Promise<SessionMessage[] | undefined> {
    const all: SessionMessage[] = [];
    let cursor: string | undefined;

    for (;;) {
      const query = cursor
        ? `limit=${MESSAGES_PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
        : `limit=${MESSAGES_PAGE_SIZE}&order=asc`;
      const page = await this.#request({
        method: "GET",
        path: `/api/session/${sessionID}/message?${query}`,
        schema: MessagesReplySchema,
        directory,
      });
      if (!page) return cursor ? all : undefined;

      all.push(...page.data);
      cursor = page.cursor?.next ?? undefined;
      if (!cursor || page.data.length === 0) return all;
    }
  }
}
