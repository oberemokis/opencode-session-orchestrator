import { execFile, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { socketPath } from "./rpc-client.js";

const execFileAsync = promisify(execFile);

const MIN_NODE_MAJOR = 24;
const MIN_NODE_MINOR = 11;
const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_COOLDOWN_MS = 30_000;
const POLL_MS = 100;
const LOCK_FILE = "spawn.lock";
const LOG_FILE = "runtime.log";
const LOG_LIMIT_BYTES = 1_000_000;
const LOG_TAIL_CHARS = 400;

export type EnsureResult =
  | { readonly ok: true; readonly started: false }
  | { readonly ok: true; readonly started: true; readonly pid: number }
  | { readonly ok: false; readonly reason: string };

export interface EnsureOptions {
  readonly stateDir: string;
  /** The built cli.js; defaults to the one next to this module. */
  readonly cliPath?: string;
  /** Environment of the new process and source of ORCHESTRATOR_NODE; defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** How long to wait for the socket after the spawn. */
  readonly waitMs?: number;
  /** How long a failed attempt blocks the next one. */
  readonly cooldownMs?: number;
  /** Node binaries to try in order; defaults to ORCHESTRATOR_NODE, PATH, Homebrew and nvm. */
  readonly nodeCandidates?: readonly string[];
}

const inflight = new Map<string, Promise<EnsureResult>>();

/**
 * Makes sure a runtime listens on the state dir's socket, starting `cli.js serve` as a detached
 * process when nothing does. Safe to call often: concurrent calls share one attempt, and a lock
 * file keeps other processes from racing; a failed attempt is remembered for `cooldownMs`.
 */
export function ensureRuntime(options: EnsureOptions): Promise<EnsureResult> {
  const running = inflight.get(options.stateDir);
  if (running) return running;

  const attempt = start(options).finally(() => inflight.delete(options.stateDir));
  inflight.set(options.stateDir, attempt);
  return attempt;
}

async function start(options: EnsureOptions): Promise<EnsureResult> {
  const socket = socketPath(options.stateDir);
  if (await isListening(socket)) return { ok: true, started: false };

  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const env = options.env ?? process.env;
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });

  const lock = join(options.stateDir, LOCK_FILE);
  const taken = takeLock(lock, options.cooldownMs ?? DEFAULT_COOLDOWN_MS);
  if (!taken.ok) {
    // Another process is starting the runtime, or a recent attempt failed and left its reason.
    if (taken.reason) return { ok: false, reason: taken.reason };
    if (await waitForSocket(socket, waitMs)) return { ok: true, started: false };
    return { ok: false, reason: `runtime не открыл сокет за ${waitMs} мс` };
  }

  const log = join(options.stateDir, LOG_FILE);
  const fail = (reason: string): EnsureResult => {
    writeFileSync(lock, reason);
    return { ok: false, reason };
  };

  const node = await findNode(options.nodeCandidates ?? defaultNodeCandidates(env));
  if (!node) {
    return fail(
      `не нашёл Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+; задай путь в ORCHESTRATOR_NODE`,
    );
  }

  const cli = options.cliPath ?? fileURLToPath(new URL("./cli.js", import.meta.url));
  if (!existsSync(cli)) return fail(`нет ${cli}; выполни pnpm build в клоне`);

  rotateLog(log);
  const logFd = openSync(log, "a");
  const progress: { error?: Error; exited?: { code: number | null } } = {};
  let pid: number;
  try {
    const child = spawn(node, [cli, "serve"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env,
    });
    child.once("error", (error) => (progress.error = error));
    child.once("exit", (code) => (progress.exited = { code }));
    child.unref();
    pid = child.pid ?? 0;
  } catch (error) {
    return fail(`не запустил ${node}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    closeSync(logFd);
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await isListening(socket)) {
      unlinkQuietly(lock);
      return { ok: true, started: true, pid };
    }
    if (progress.error) return fail(`не запустил ${node}: ${progress.error.message}`);
    if (progress.exited) {
      return fail(`runtime сразу вышел (код ${progress.exited.code}). ${describeLog(log)}`);
    }
    await sleep(POLL_MS);
  }
  return fail(`runtime не открыл сокет за ${waitMs} мс. ${describeLog(log)}`);
}

function isListening(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socket);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

async function waitForSocket(socket: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await isListening(socket)) return true;
    await sleep(POLL_MS);
  }
  return false;
}

type Lock = { readonly ok: true } | { readonly ok: false; readonly reason: string | undefined };

/** The lock is created exclusively; a failed attempt writes its reason into it and keeps it. */
function takeLock(lock: string, cooldownMs: number): Lock {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lock, "wx"));
      return { ok: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let age: number;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue;
    }
    if (age < cooldownMs) return { ok: false, reason: readQuietly(lock)?.trim() || undefined };
    unlinkQuietly(lock);
  }
  return { ok: false, reason: undefined };
}

function rotateLog(log: string): void {
  try {
    if (statSync(log).size > LOG_LIMIT_BYTES) renameSync(log, `${log}.1`);
  } catch {
    // No log yet.
  }
}

function describeLog(log: string): string {
  const tail = readQuietly(log)?.trim().slice(-LOG_TAIL_CHARS);
  return tail ? `${log}: …${tail}` : `Лог: ${log}`;
}

function readQuietly(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

function defaultNodeCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates = [
    env.ORCHESTRATOR_NODE,
    "node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    ...nvmNodes(join(homedir(), ".nvm", "versions", "node")),
  ];
  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

/** nvm keeps one directory per version; the newest goes first. */
function nvmNodes(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
    .sort((left, right) => compareVersions(right, left))
    .map((name) => join(root, name, "bin", "node"));
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.slice(1).split(".").map(Number);
  const rightParts = right.slice(1).split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function findNode(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate, ["--version"], { timeout: 5_000 });
      if (isSupportedNode(stdout.trim())) return candidate;
    } catch {
      // Not installed under this name; try the next one.
    }
  }
  return undefined;
}

function isSupportedNode(version: string): boolean {
  const parts = /^v(\d+)\.(\d+)/.exec(version);
  if (!parts) return false;

  const major = Number(parts[1]);
  const minor = Number(parts[2]);
  return major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
