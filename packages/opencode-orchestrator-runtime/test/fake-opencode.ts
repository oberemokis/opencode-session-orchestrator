import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Behaviour copied from OpenCode 2.4.1 as checked on step 0 (docs/first-delivery.md). */

export interface FakeMessage {
  id: string;
  type: string;
  text?: string;
  metadata?: Record<string, unknown>;
  outcome?: string;
  error?: { type: string; message: string };
  content?: unknown[];
  finish?: string;
}

export interface FakeSession {
  id: string;
  directory: string;
  agent: string | undefined;
  title: string | undefined;
  metadata: Record<string, unknown>;
  permissions: unknown[];
  model: { providerID: string; id: string; variant?: string } | undefined;
  time: { created: number; updated: number };
  messages: FakeMessage[];
  notes: { id: string; text: string; resume: boolean }[];
  interrupted: number;
}

export interface PromptCall {
  readonly session: FakeSession;
  readonly text: string;
  readonly stageRunID: string | undefined;
  /** Appends an assistant message with a stage_report tool part. */
  report(
    input:
      | { outcome?: string; summary?: string; stageRunID?: string; status?: string }
      | Record<string, never>,
  ): void;
  idle(outcome?: string): void;
  push(message: Omit<FakeMessage, "id">): void;
}

export class FakeOpenCode {
  readonly sessions = new Map<string, FakeSession>();
  readonly requests: string[] = [];
  version = "2.4.1";
  agents = new Set(["orchestrator-worker"]);
  mcpServers = ["YouTrack", "gitlab"];
  models = [{ providerID: "openai", id: "gpt-5.6-luna" }];
  down = false;
  /** Answers GET /api/session/:id without `location` and `time`, as a changed API would. */
  breakSessionShape = false;
  hijackNextSession: string | null = null;
  onPrompt: (call: PromptCall) => void | Promise<void> = () => {};
  #server: Server | undefined;
  #seq = 0;

  get url(): string {
    const address = this.#server?.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async start(): Promise<this> {
    this.#server = createServer((request, response) => {
      void this.#handle(request).then(
        ({ status, body }) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(body === undefined ? "" : JSON.stringify(body));
        },
        (error: unknown) => {
          response.writeHead(500);
          response.end(String(error));
        },
      );
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
    return this;
  }

  async close(): Promise<void> {
    this.#server?.closeAllConnections();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  addLeadSession(id: string, directory: string): FakeSession {
    return this.#createSession({ id, location: { directory } });
  }

  nextID(prefix: string): string {
    this.#seq++;
    return `${prefix}fake${String(this.#seq).padStart(6, "0")}`;
  }

  findMessage(id: string): { session: FakeSession; message: FakeMessage } | undefined {
    for (const session of this.sessions.values()) {
      const message = session.messages.find((candidate) => candidate.id === id);
      if (message) return { session, message };
    }
    return undefined;
  }

  callFor(session: FakeSession, text: string): PromptCall {
    const stageRunID = /stageRunID "([^"]+)"/.exec(text)?.[1];
    const push = (message: Omit<FakeMessage, "id">) => {
      session.messages.push({ id: this.nextID("msg_"), ...message });
      session.time.updated = Date.now();
    };
    return {
      session,
      text,
      stageRunID,
      push,
      report: (input) => {
        const fullInput =
          "outcome" in input || "summary" in input || "stageRunID" in input
            ? { stageRunID, outcome: "passed", summary: "готово", ...input }
            : {};
        const status =
          "status" in input && typeof input.status === "string" ? input.status : "completed";
        push({
          type: "assistant",
          finish: "tool-calls",
          content: [
            {
              type: "tool",
              id: this.nextID("call_"),
              name: "stage_report",
              state: { status, input: fullInput },
            },
          ],
        });
      },
      idle: (outcome = "succeeded") => push({ type: "idle", outcome }),
    };
  }

  async #handle(request: IncomingMessage): Promise<{ status: number; body?: unknown }> {
    const url = new URL(request.url ?? "/", "http://fake");
    const body = await readBody(request);
    this.requests.push(`${request.method} ${url.pathname}`);
    if (this.down) return { status: 503, body: { error: "down" } };

    const parts = url.pathname.split("/").filter(Boolean);
    const route = `${request.method} /${parts.map((part, index) => (index === 2 && parts[1] === "session" ? ":id" : part)).join("/")}`;
    const session = parts[1] === "session" && parts[2] ? this.sessions.get(parts[2]) : undefined;

    switch (route) {
      case "GET /api/info":
        return { status: 200, body: { version: this.version, pid: 1, urls: [] } };
      case "GET /api/mcp":
        return {
          status: 200,
          body: {
            data: this.mcpServers.map((name) => ({ name, status: { status: "connected" } })),
          },
        };
      case "GET /api/model":
        return { status: 200, body: { data: this.models } };
      case "POST /api/session":
        return { status: 200, body: { data: this.#createSession(body) } };
      case "GET /api/session/:id":
        if (!session) return { status: 404 };
        return {
          status: 200,
          body: { data: this.breakSessionShape ? { id: session.id } : view(session) },
        };
      case "DELETE /api/session/:id":
        if (session) this.sessions.delete(session.id);
        return { status: session ? 204 : 404 };
      case "GET /api/session/:id/message":
        return session
          ? { status: 200, body: { data: session.messages, cursor: { next: null } } }
          : { status: 404 };
      case "POST /api/session/:id/model":
        if (!session) return { status: 404 };
        session.model = {
          variant: "default",
          ...(body.model as { providerID: string; id: string }),
        };
        session.messages.push({ id: this.nextID("msg_"), type: "model-switched" });
        return { status: 204 };
      case "POST /api/session/:id/prompt":
        return session ? this.#prompt(session, body) : { status: 404 };
      case "POST /api/session/:id/synthetic": {
        if (!session) return { status: 404 };
        const id = String(body.id);
        if (!session.notes.some((note) => note.id === id))
          session.notes.push({ id, text: String(body.text), resume: body.resume === true });
        return { status: 200, body: { data: { id } } };
      }
      case "POST /api/session/:id/interrupt":
        if (!session) return { status: 404 };
        session.interrupted++;
        return { status: 200, body: { interrupted: true } };
      default:
        if (request.method === "GET" && parts[1] === "agent" && parts[2]) {
          return this.agents.has(parts[2])
            ? { status: 200, body: { data: { id: parts[2] } } }
            : { status: 404 };
        }
        return { status: 404, body: { error: `fake: no route ${route}` } };
    }
  }

  #createSession(body: Record<string, unknown>): FakeSession {
    const id = typeof body.id === "string" ? body.id : this.nextID("ses_");
    const existing = this.sessions.get(id);
    if (existing) return existing;

    const now = Date.now();
    // Simulates a session with the same id that already belongs to someone else.
    const hijacked = this.hijackNextSession;
    this.hijackNextSession = null;
    const session: FakeSession = {
      id,
      directory: hijacked ?? (body.location as { directory: string }).directory,
      agent: body.agent as string | undefined,
      title: body.title as string | undefined,
      metadata: (body.metadata as Record<string, unknown>) ?? {},
      permissions: (body.permissions as unknown[]) ?? [],
      model: undefined,
      time: { created: now, updated: now },
      messages: [],
      notes: [],
      interrupted: 0,
    };
    this.sessions.set(id, session);
    return session;
  }

  #prompt(session: FakeSession, body: Record<string, unknown>): { status: number; body?: unknown } {
    const id = String(body.id);
    const existing = this.findMessage(id);
    if (existing) {
      if (existing.session !== session || existing.message.type !== "user")
        return { status: 409, body: { _tag: "ConflictError" } };
      return { status: 200, body: { data: existing.message } };
    }

    const text = String(body.text);
    session.messages.push({ id, type: "user", text });
    session.time.updated = Date.now();
    setTimeout(() => void this.onPrompt(this.callFor(session, text)), 5);
    return { status: 200, body: { data: { id } } };
  }
}

function view(session: FakeSession) {
  const {
    messages: _messages,
    notes: _notes,
    interrupted: _interrupted,
    directory,
    ...rest
  } = session;
  return { ...rest, location: { directory } };
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}
