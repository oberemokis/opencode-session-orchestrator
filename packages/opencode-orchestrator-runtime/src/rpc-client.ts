import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { describeIssue } from "./core/issue.js";

const DEFAULT_TIMEOUT_MS = 30_000;

const ReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string().optional() }),
]);

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ORCHESTRATOR_STATE_DIR || join(homedir(), ".local", "state", "opencode-orchestrator");
}

export function socketPath(stateDir: string): string {
  return join(stateDir, "runtime.sock");
}

export class RuntimeUnavailableError extends Error {}

/**
 * Calls a runtime RPC method over the Unix socket and checks the answer against `schema`.
 * Throws RuntimeUnavailableError when nothing listens.
 */
export function callRuntime<Schema extends z.ZodType>(call: {
  socket: string;
  method: string;
  schema: Schema;
  input?: unknown;
  timeoutMs?: number;
}): Promise<z.infer<Schema>> {
  const { socket, method, schema, input = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = call;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify(input);
    const outgoing = request(
      {
        socketPath: socket,
        path: `/rpc/${method}`,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve(readReply(method, schema, Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    outgoing.on("timeout", () =>
      outgoing.destroy(new Error(`runtime не ответил за ${timeoutMs} мс`)),
    );
    outgoing.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED")
        reject(new RuntimeUnavailableError("runtime не запущен"));
      else reject(error);
    });
    outgoing.end(body);
  });
}

function readReply<Schema extends z.ZodType>(
  method: string,
  schema: Schema,
  text: string,
): z.infer<Schema> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`runtime ответил на ${method} не JSON`);
  }

  const reply = ReplySchema.safeParse(raw);
  if (!reply.success) throw new Error(`ответ runtime на ${method}: ${describeIssue(reply.error)}`);
  if (!reply.data.ok) throw new Error(reply.data.error ?? "ошибка runtime");

  const result = schema.safeParse(reply.data.result);
  if (!result.success)
    throw new Error(`ответ runtime на ${method}: ${describeIssue(result.error)}`);
  return result.data;
}
