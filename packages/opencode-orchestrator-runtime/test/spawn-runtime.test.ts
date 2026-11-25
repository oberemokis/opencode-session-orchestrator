import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { callRuntime, socketPath } from "../src/rpc-client.js";
import { StatusReplySchema } from "../src/rpc-contract.js";
import { type EnsureOptions, type EnsureResult, ensureRuntime } from "../src/spawn-runtime.js";
import { FakeOpenCode } from "./fake-opencode.js";
import "./harness.js";

// The test starts the real built cli.js, so `pnpm build` must have run.
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`нет ${CLI}: сначала pnpm build`);
});

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function setup() {
  const fake = await new FakeOpenCode().start();
  const stateDir = mkdtempSync("/tmp/oo-state-");
  cleanup.push(
    () => fake.close(),
    () => rmSync(stateDir, { recursive: true, force: true }),
  );

  const options: EnsureOptions = {
    stateDir,
    cliPath: CLI,
    nodeCandidates: [process.execPath],
    env: {
      ...process.env,
      ORCHESTRATOR_STATE_DIR: stateDir,
      ORCHESTRATOR_OPENCODE_URL: fake.url,
    },
  };
  return { fake, stateDir, options };
}

/** Stops a runtime the test started, so no process outlives it. */
function stopLater(stateDir: string, result: EnsureResult): void {
  if (!result.ok || !result.started) return;
  cleanup.push(async () => {
    process.kill(result.pid, "SIGTERM");
    const deadline = Date.now() + 5_000;
    while (existsSync(socketPath(stateDir)) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

function status(stateDir: string) {
  return callRuntime({ socket: socketPath(stateDir), method: "status", schema: StatusReplySchema });
}

describe("автозапуск runtime", () => {
  test("поднимает runtime, и он отвечает; повторный вызов второй процесс не запускает", async () => {
    const { stateDir, options } = await setup();

    const first = await ensureRuntime(options);
    stopLater(stateDir, first);

    expect(first).toMatchObject({ ok: true, started: true });
    expect(await status(stateDir)).toEqual({ tasks: [] });
    expect(await ensureRuntime(options)).toEqual({ ok: true, started: false });
    expect(existsSync(join(stateDir, "spawn.lock"))).toBe(false);
  });

  test("одновременные вызовы делят одну попытку", async () => {
    const { stateDir, options } = await setup();

    const [left, right] = await Promise.all([ensureRuntime(options), ensureRuntime(options)]);
    stopLater(stateDir, left);

    expect(left).toMatchObject({ ok: true, started: true });
    expect(right).toEqual(left);
  });

  test("свежий замок с причиной: новая попытка не запускается, причина возвращается", async () => {
    const { stateDir, options } = await setup();
    writeFileSync(join(stateDir, "spawn.lock"), "прошлая попытка не удалась");

    expect(await ensureRuntime(options)).toEqual({
      ok: false,
      reason: "прошлая попытка не удалась",
    });
    expect(existsSync(socketPath(stateDir))).toBe(false);
  });

  test("устаревший замок снимается, runtime запускается", async () => {
    const { stateDir, options } = await setup();
    const lock = join(stateDir, "spawn.lock");
    writeFileSync(lock, "давняя неудача");
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lock, longAgo, longAgo);

    const result = await ensureRuntime(options);
    stopLater(stateDir, result);

    expect(result).toMatchObject({ ok: true, started: true });
  });

  test("нет подходящего Node: причина названа, повтор в паузу её же и отдаёт", async () => {
    const { stateDir, options } = await setup();
    const withoutNode = { ...options, nodeCandidates: ["/nonexistent/node"] };

    const first = await ensureRuntime(withoutNode);
    expect(first).toMatchObject({ ok: false, reason: expect.stringContaining("Node.js 24.11") });

    expect(await ensureRuntime(options)).toEqual(first);
    expect(readFileSync(join(stateDir, "spawn.lock"), "utf8")).toContain("ORCHESTRATOR_NODE");
  });

  test("нет cli.js: причина просит собрать пакет", async () => {
    const { options } = await setup();

    expect(await ensureRuntime({ ...options, cliPath: "/nonexistent/cli.js" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("pnpm build"),
    });
  });

  test("runtime сразу вышел: в причине хвост runtime.log", async () => {
    const { fake, stateDir, options } = await setup();
    fake.version = "3.0.0";

    const result = await ensureRuntime(options);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("не поддерживается"),
    });
    expect(result.ok ? "" : result.reason).toContain(join(stateDir, "runtime.log"));
  });
});
