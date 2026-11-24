import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { checkUnattendedCommit } from "./git.js";
import { OpenCodeClient, type OpenCodeTarget } from "./opencode.js";
import { socketPath } from "./rpc-client.js";
import { listenRpc } from "./rpc-server.js";
import { Service } from "./service.js";
import { Store } from "./store.js";

/** The OpenCode minor this runtime was checked against. Other minors change the API it relies on. */
export const SUPPORTED_OPENCODE = "2.4";

export interface RuntimeOptions {
  readonly stateDir: string;
  readonly opencode: OpenCodeTarget;
  readonly slots?: number;
  readonly tickMs?: number;
  readonly retryBaseMs?: number;
  readonly maxIntentAttempts?: number;
  readonly stallUnitMs?: number;
  readonly log?: (line: string) => void;
  readonly skipStartupChecks?: boolean;
}

export interface RuntimeHandle {
  readonly engine: Engine;
  readonly service: Service;
  readonly socket: string;
  /** Graceful shutdown: waits for in-flight work. */
  close(): Promise<void>;
  /** Abrupt stop: in-flight work is abandoned without writing its result, as after kill -9. */
  crash(): void;
}

export class StartupError extends Error {}

export async function startRuntime(options: RuntimeOptions): Promise<RuntimeHandle> {
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  const opencode = new OpenCodeClient(options.opencode);

  if (!options.skipStartupChecks) await runStartupChecks(opencode, options.stateDir);

  const store = new Store(join(options.stateDir, "state.db"));
  const engine = new Engine({
    store,
    opencode,
    slots: options.slots ?? 3,
    tickMs: options.tickMs ?? 15_000,
    retryBaseMs: options.retryBaseMs ?? 1_000,
    maxIntentAttempts: options.maxIntentAttempts ?? 5,
    stallUnitMs: options.stallUnitMs ?? 60_000,
    log: options.log ?? ((line) => console.log(`${new Date().toISOString()} ${line}`)),
  });
  const service = new Service(engine);
  const socket = socketPath(options.stateDir);

  let server: Server;
  try {
    server = await listenRpc(socket, service);
  } catch (error) {
    store.close();
    throw error;
  }
  engine.start();

  return {
    engine,
    service,
    socket,
    async close() {
      engine.halt();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await engine.idle();
      store.close();
    },
    crash() {
      engine.halt();
      server.close();
      server.closeAllConnections();
      store.close();
    },
  };
}

export async function runStartupChecks(opencode: OpenCodeClient, stateDir: string): Promise<void> {
  const version = await opencode.version().catch((error: Error) => {
    throw new StartupError(`OpenCode недоступен: ${error.message}`);
  });
  const minor = version.split(".").slice(0, 2).join(".");
  if (minor !== SUPPORTED_OPENCODE) {
    throw new StartupError(`OpenCode ${version} не поддерживается: runtime проверен на ${SUPPORTED_OPENCODE}.x`);
  }

  const signing = await checkUnattendedCommit(stateDir);
  if (signing) throw new StartupError(signing);
}
