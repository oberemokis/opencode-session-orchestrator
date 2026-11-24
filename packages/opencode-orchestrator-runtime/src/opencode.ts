import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PermissionRule } from "./core/permissions.js";
import type { ModelRef } from "./core/workflow.js";

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

export interface SessionInfo {
  readonly id: string;
  readonly agent?: string;
  readonly model?: { readonly providerID: string; readonly id: string; readonly variant?: string };
  readonly metadata?: Record<string, unknown>;
  readonly location: { readonly directory: string };
  readonly time: { readonly created: number; readonly updated: number; readonly busy?: number; readonly idle?: number };
}

export interface ToolPart {
  readonly type: "tool";
  readonly id: string;
  readonly name: string;
  readonly state: { readonly status: string; readonly input?: unknown; readonly error?: unknown };
}

export interface SessionMessage {
  readonly id: string;
  readonly type: string;
  readonly metadata?: Record<string, unknown>;
  readonly outcome?: string;
  readonly error?: { readonly type?: string; readonly message?: string };
  readonly content?: readonly ({ readonly type: string } | ToolPart)[];
  readonly finish?: string;
}

export function discoverOpenCode(env: NodeJS.ProcessEnv = process.env): OpenCodeTarget {
  if (env.ORCHESTRATOR_OPENCODE_URL) {
    return { url: env.ORCHESTRATOR_OPENCODE_URL, password: env.ORCHESTRATOR_OPENCODE_PASSWORD ?? null };
  }

  const stateHome = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  const file = join(stateHome, "opencode", "service.json");
  const service = JSON.parse(readFileSync(file, "utf8")) as { url?: string; password?: string };
  if (!service.url) throw new Error(`в ${file} нет адреса службы OpenCode; запусти opencode serve --service`);
  return { url: service.url, password: service.password ?? null };
}

export class OpenCodeClient {
  readonly #target: OpenCodeTarget;

  constructor(target: OpenCodeTarget) {
    this.#target = target;
  }

  async #request<Body>(input: { method: string; path: string; directory?: string; body?: unknown }): Promise<Body | undefined> {
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
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();

    if (response.status === 404) return undefined;
    if (!response.ok) {
      const message = `${input.method} ${url.pathname} -> ${response.status}: ${text.slice(0, 300)}`;
      throw new OpenCodeError(message, response.status);
    }
    return text ? (JSON.parse(text) as Body) : undefined;
  }

  async version(): Promise<string> {
    const info = await this.#request<{ version: string }>({ method: "GET", path: "/api/info" });
    if (!info) throw new Error("OpenCode не отдал /api/info");
    return info.version;
  }

  async session(id: string, directory: string): Promise<SessionInfo | undefined> {
    const response = await this.#request<{ data: SessionInfo }>({ method: "GET", path: `/api/session/${id}`, directory });
    return response?.data;
  }

  async createSession(input: {
    id: string;
    directory: string;
    agent: string;
    title: string;
    metadata: Record<string, unknown>;
    permissions: readonly PermissionRule[];
  }): Promise<SessionInfo> {
    const response = await this.#request<{ data: SessionInfo }>({
      method: "POST",
      path: "/api/session",
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
    return (await this.#request({ method: "GET", path: `/api/agent/${name}`, directory })) !== undefined;
  }

  async mcpServers(directory: string): Promise<string[]> {
    const response = await this.#request<{ data: { name: string }[] }>({ method: "GET", path: "/api/mcp", directory });
    return (response?.data ?? []).map((server) => server.name);
  }

  async models(directory: string): Promise<ModelRef[]> {
    const response = await this.#request<{ data: { providerID: string; id: string }[] }>({ method: "GET", path: "/api/model", directory });
    return (response?.data ?? []).map((model) => ({ providerID: model.providerID, id: model.id }));
  }

  async switchModel(sessionID: string, directory: string, model: ModelRef): Promise<void> {
    await this.#request({ method: "POST", path: `/api/session/${sessionID}/model`, directory, body: { model } });
  }

  async prompt(sessionID: string, directory: string, message: { id: string; text: string }): Promise<void> {
    const response = await this.#request({ method: "POST", path: `/api/session/${sessionID}/prompt`, directory, body: message });
    if (response === undefined) throw new OpenCodeError(`сессия ${sessionID} не найдена`, 404);
  }

  async note(sessionID: string, directory: string, message: { id: string; text: string }): Promise<void> {
    const response = await this.#request({
      method: "POST",
      path: `/api/session/${sessionID}/synthetic`,
      directory,
      body: { ...message, description: "opencode-orchestrator", resume: false },
    });
    if (response === undefined) throw new OpenCodeError(`чат ${sessionID} не найден`, 404);
  }

  async interrupt(sessionID: string, directory?: string): Promise<void> {
    await this.#request({ method: "POST", path: `/api/session/${sessionID}/interrupt`, ...(directory ? { directory } : {}), body: {} });
  }

  async deleteSession(sessionID: string): Promise<void> {
    await this.#request({ method: "DELETE", path: `/api/session/${sessionID}` });
  }

  async messages(sessionID: string, directory: string): Promise<SessionMessage[] | undefined> {
    const all: SessionMessage[] = [];
    let cursor: string | undefined;

    for (;;) {
      const query = cursor ? `limit=200&cursor=${encodeURIComponent(cursor)}` : "limit=200&order=asc";
      const page = await this.#request<{ data: SessionMessage[]; cursor?: { next?: string | null } }>({
        method: "GET",
        path: `/api/session/${sessionID}/message?${query}`,
        directory,
      });
      if (!page) return cursor ? all : undefined;

      all.push(...page.data);
      cursor = page.cursor?.next ?? undefined;
      if (!cursor || page.data.length === 0) return all;
    }
  }
}
