import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { callRuntime, socketPath } from "../src/rpc-client.js";
import { StatusReplySchema } from "../src/rpc-contract.js";
import { SocketBusyError } from "../src/rpc-server.js";
import { type RuntimeHandle, StartupError, startRuntime } from "../src/runtime.js";
import { CorruptStateError, SchemaTooNewError } from "../src/store.js";
import { FakeOpenCode } from "./fake-opencode.js";
import "./harness.js";

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
  return { fake, stateDir };
}

function status(socket: string) {
  return callRuntime({ socket, method: "status", schema: StatusReplySchema });
}

function boot(stateDir: string, fake: FakeOpenCode, checks = false): Promise<RuntimeHandle> {
  return startRuntime({
    stateDir,
    opencode: { url: fake.url, password: null },
    tickMs: 50,
    skipStartupChecks: !checks,
    log: () => {},
  });
}

describe("старт serve", () => {
  test("случай 27: сокет, оставшийся после kill -9, не мешает; второй живой serve отказывается", async () => {
    const { fake, stateDir } = await setup();
    const socket = socketPath(stateDir);
    const orphan = spawn(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(socket)}, () => console.log("up"))`,
    ]);
    await new Promise((resolve) => orphan.stdout.once("data", resolve));
    orphan.kill("SIGKILL");
    await new Promise((resolve) => orphan.once("exit", resolve));
    expect(existsSync(socket)).toBe(true);

    const runtime = await boot(stateDir, fake);
    cleanup.push(() => runtime.close());
    expect(await status(socket)).toEqual({ tasks: [] });

    await expect(boot(stateDir, fake)).rejects.toBeInstanceOf(SocketBusyError);
    expect(await status(socket)).toEqual({ tasks: [] });
  });

  test("случай 28: с базой новее кода runtime не стартует", async () => {
    const { fake, stateDir } = await setup();
    const db = new DatabaseSync(join(stateDir, "state.db"));
    db.exec("PRAGMA user_version = 99");
    db.close();

    await expect(boot(stateDir, fake)).rejects.toBeInstanceOf(SchemaTooNewError);
    expect(existsSync(socketPath(stateDir))).toBe(false);
  });

  test.each([
    ["в состоянии нет обязательного поля", '{"id":"tbroken"}', /задача tbroken: salt/],
    ["состояние не JSON", "not json", /задача tbroken: состояние не является JSON/],
  ])(
    "случай 38: битая строка задачи, %s: runtime не стартует и называет задачу",
    async (_name, state, message) => {
      const { fake, stateDir } = await setup();
      await (await boot(stateDir, fake)).close();

      const db = new DatabaseSync(join(stateDir, "state.db"));
      db.prepare(
        "INSERT INTO tasks (id, seq, status, state, revision, created_at, updated_at) VALUES ('tbroken', 1, 'queued', ?, 1, 0, 0)",
      ).run(state);
      db.close();

      const failure = await boot(stateDir, fake).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(CorruptStateError);
      expect(failure).toHaveProperty("message", expect.stringMatching(message));
      expect(existsSync(socketPath(stateDir))).toBe(false);
    },
  );

  test("случай 34: не стартует на незнакомой версии OpenCode и называет причину", async () => {
    const { fake, stateDir } = await setup();
    fake.version = "2.5.0";

    await expect(boot(stateDir, fake, true)).rejects.toThrow(
      new StartupError("OpenCode 2.5.0 не поддерживается: runtime проверен на 2.4.x"),
    );
  });

  test("не стартует, когда коммит требует подписи, которую нельзя сделать без человека", async () => {
    const { fake, stateDir } = await setup();
    const previous = process.env.GIT_CONFIG_GLOBAL;
    const signing = join(stateDir, "signing.gitconfig");
    writeFileSync(
      signing,
      "[user]\n\tname = T\n\temail = t@example.com\n\tsigningkey = ABC\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n",
    );
    process.env.GIT_CONFIG_GLOBAL = signing;
    cleanup.push(() => {
      process.env.GIT_CONFIG_GLOBAL = previous;
    });

    await expect(boot(stateDir, fake, true)).rejects.toThrow(/подпись коммита/);
  });

  test("на поддерживаемой версии и с обычным коммитом стартует", async () => {
    const { fake, stateDir } = await setup();
    const runtime = await boot(stateDir, fake, true);
    cleanup.push(() => runtime.close());
    expect(await status(runtime.socket)).toEqual({ tasks: [] });
  });
});
