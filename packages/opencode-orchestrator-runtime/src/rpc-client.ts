import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ORCHESTRATOR_STATE_DIR || join(homedir(), ".local", "state", "opencode-orchestrator");
}

export function socketPath(stateDir: string): string {
  return join(stateDir, "runtime.sock");
}

export class RuntimeUnavailableError extends Error {}

/** Calls a runtime RPC method over the Unix socket. Throws RuntimeUnavailableError when nothing listens. */
export function callRuntime(socket: string, method: string, input: unknown = {}, timeoutMs = 30_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(input);
    const call = request(
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
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ok: boolean; result?: unknown; error?: string };
          if (parsed.ok) resolve(parsed.result);
          else reject(new Error(parsed.error ?? "ошибка runtime"));
        });
      },
    );

    call.on("timeout", () => call.destroy(new Error(`runtime не ответил за ${timeoutMs} мс`)));
    call.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") reject(new RuntimeUnavailableError("runtime не запущен"));
      else reject(error);
    });
    call.end(body);
  });
}
