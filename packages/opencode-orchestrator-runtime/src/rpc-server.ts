import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import type { Service } from "./service.js";

export class SocketBusyError extends Error {}

/** A live socket means another serve owns this state dir; a dead one is a leftover from a crash. */
async function clearStaleSocket(path: string): Promise<void> {
  if (!existsSync(path)) return;

  const alive = await new Promise<boolean>((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
  if (alive) throw new SocketBusyError(`${path} уже обслуживает другой serve`);
  unlinkSync(path);
}

export async function listenRpc(path: string, service: Service): Promise<Server> {
  await clearStaleSocket(path);

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const method = request.url?.startsWith("/rpc/") ? request.url.slice("/rpc/".length) : "";
      const send = (payload: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };

      let input: unknown;
      try {
        input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      } catch {
        send({ ok: false, error: "тело запроса не JSON" });
        return;
      }

      service
        .call(method, input)
        .then((result) => send({ ok: true, result }))
        .catch((error: unknown) => send({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  chmodSync(path, 0o600);
  return server;
}
