import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { callRuntime, socketPath } from "../src/rpc-client.js";
import { SocketBusyError } from "../src/rpc-server.js";
import { type RuntimeHandle, StartupError, startRuntime } from "../src/runtime.js";
import { SchemaTooNewError } from "../src/store.js";
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
  // случай 27
  test("сокет, оставшийся после kill -9, не мешает; второй живой serve отказывается", async () => {
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
    expect(await callRuntime(socket, "status")).toEqual({ tasks: [] });

    await expect(boot(stateDir, fake)).rejects.toBeInstanceOf(SocketBusyError);
    expect(await callRuntime(socket, "status")).toEqual({ tasks: [] });
  });

  // случай 28
  test("с базой новее кода runtime не стартует", async () => {
    const { fake, stateDir } = await setup();
    const db = new DatabaseSync(join(stateDir, "state.db"));
    db.exec("PRAGMA user_version = 99");
    db.close();

    await expect(boot(stateDir, fake)).rejects.toBeInstanceOf(SchemaTooNewError);
    expect(existsSync(socketPath(stateDir))).toBe(false);
  });

  // случай 34
  test("не стартует на незнакомой версии OpenCode и называет причину", async () => {
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
    expect(await callRuntime(runtime.socket, "status")).toEqual({ tasks: [] });
  });
});
