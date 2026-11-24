import { execFile } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { PermanentError } from "./permanent-error.js";

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const MAX_OUTPUT = 20_000;
const SETUP_TIMEOUT_MS = 15 * 60_000;

export function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeout: options.timeout ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({
          code,
          stdout: String(stdout),
          stderr: String(stderr) || (error && code !== 0 && !stderr ? error.message : ""),
        });
      },
    );
  });
}

export async function git(
  cwd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await run("git", args, { cwd, ...(env ? { env } : {}) });
  if (result.code !== 0)
    throw new Error(`git ${args.join(" ")}: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

function tail(text: string): string {
  return text.length > MAX_OUTPUT ? `…${text.slice(-MAX_OUTPUT)}` : text;
}

export async function projectRoot(directory: string): Promise<string> {
  const common = await git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const top = await git(directory, ["rev-parse", "--show-toplevel"]);
  // A chat opened inside a worktree still belongs to the main checkout.
  return common.endsWith("/.git") ? dirname(common) : top;
}

export async function resolveCommit(projectDir: string, ref: string): Promise<string> {
  return git(projectDir, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

export async function ensureWorktree(input: {
  projectDir: string;
  path: string;
  branch: string;
  base: string;
}): Promise<void> {
  await git(input.projectDir, ["worktree", "prune"]);
  excludeWorktrees(
    await git(input.projectDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );

  const listing = await git(input.projectDir, ["worktree", "list", "--porcelain"]);
  const registered = listing
    .split("\n\n")
    .find((block) => block.split("\n")[0] === `worktree ${input.path}`);
  if (registered) {
    if (!registered.includes(`branch refs/heads/${input.branch}`)) {
      throw new PermanentError(`в ${input.path} уже стоит другой worktree`);
    }
    return;
  }

  const branchExists =
    (
      await run("git", ["rev-parse", "--verify", `refs/heads/${input.branch}`], {
        cwd: input.projectDir,
      })
    ).code === 0;
  const args = branchExists
    ? ["worktree", "add", input.path, input.branch]
    : ["worktree", "add", "-b", input.branch, input.path, input.base];
  await git(input.projectDir, args);
}

function excludeWorktrees(commonDir: string): void {
  const file = join(commonDir, "info", "exclude");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split("\n").includes("/.worktrees/")) return;

  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${current.endsWith("\n") || current === "" ? "" : "\n"}/.worktrees/\n`);
}

export async function prepareWorktree(input: {
  projectDir: string;
  path: string;
  copy: readonly string[];
  command: string | null;
}): Promise<void> {
  for (const relative of input.copy) {
    if (isAbsolute(relative) || relative.split("/").includes(".."))
      throw new PermanentError(`setup.copy: недопустимый путь ${relative}`);

    const source = join(input.projectDir, relative);
    if (!existsSync(source))
      throw new PermanentError(`setup.copy: в главном checkout нет ${relative}`);
    mkdirSync(dirname(join(input.path, relative)), { recursive: true });
    copyFileSync(source, join(input.path, relative));
  }

  if (!input.command) return;
  const result = await run("sh", ["-c", input.command], {
    cwd: input.path,
    timeout: SETUP_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw new PermanentError(
      `setup.command завершилась с кодом ${result.code}:\n${tail(`${result.stdout}${result.stderr}`)}`,
    );
  }
}

export async function snapshotTree(path: string): Promise<string> {
  const index = join(
    tmpdir(),
    `oo-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const env = { GIT_INDEX_FILE: index };

  try {
    await git(path, ["read-tree", "HEAD"], env);
    await git(path, ["add", "-A"], env);
    return await git(path, ["write-tree"], env);
  } finally {
    rmSync(index, { force: true });
  }
}

export type CommitOutcome =
  | { kind: "ok" }
  | { kind: "hook-rejected"; output: string }
  | { kind: "tree-mismatch"; output: string };

export async function commitReviewedTree(input: {
  path: string;
  base: string;
  tree: string;
  message: string;
}): Promise<CommitOutcome> {
  const head = await git(input.path, ["rev-parse", "HEAD"]);
  if (head !== input.base) {
    const parent = await git(input.path, ["rev-parse", "HEAD^"]).catch(() => "");
    const headTree = await git(input.path, ["rev-parse", "HEAD^{tree}"]);
    if (parent === input.base && headTree === input.tree) return { kind: "ok" };
    throw new PermanentError(`HEAD ветки задачи ${head} не равен базе ${input.base}`);
  }

  await git(input.path, ["read-tree", input.tree]);
  const result = await run("git", ["commit", "--quiet", "-m", input.message], {
    cwd: input.path,
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
  const output = tail(`${result.stdout}${result.stderr}`.trim());

  if (result.code !== 0) {
    if (/index\.lock|Unable to create|fatal: /i.test(output))
      throw new Error(`git commit: ${output}`);
    return { kind: "hook-rejected", output };
  }

  const committed = await git(input.path, ["rev-parse", "HEAD^{tree}"]);
  if (committed === input.tree) return { kind: "ok" };

  const changed = await git(input.path, ["diff", "--stat", input.tree, committed]);
  await git(input.path, ["reset", "--soft", input.base]);
  return { kind: "tree-mismatch", output: `${output}\n${changed}`.trim() };
}

export async function removeWorktree(projectDir: string, path: string): Promise<void> {
  if (!existsSync(path)) {
    await git(projectDir, ["worktree", "prune"]);
    return;
  }
  await git(projectDir, ["worktree", "remove", "--force", path]);
}

export interface FileChange {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly sensitive: boolean;
  readonly patch: string;
}

const SENSITIVE = [
  /^\.orchestrator\//,
  /^\.opencode\//,
  /^opencode\.jsonc?$/,
  /^\.husky\//,
  /^\.githooks\//,
  /^lefthook\.ya?ml$/,
  /^\.pre-commit-config\.yaml$/,
];

export async function diffTree(input: {
  cwd: string;
  base: string;
  tree: string;
}): Promise<FileChange[]> {
  const numstat = await git(input.cwd, [
    "diff",
    "--numstat",
    "-z",
    "--no-renames",
    input.base,
    input.tree,
  ]);
  const patch = await git(input.cwd, [
    "diff",
    "--no-renames",
    "--no-color",
    input.base,
    input.tree,
  ]);
  const patches = splitPatch(patch);

  return numstat
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [additions = "0", deletions = "0", ...rest] = line.split("\t");
      const path = rest.join("\t");
      return {
        path,
        additions: Number(additions) || 0,
        deletions: Number(deletions) || 0,
        sensitive: SENSITIVE.some((pattern) => pattern.test(path)),
        patch: patches.get(path) ?? "",
      };
    });
}

function splitPatch(patch: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    const match = /^diff --git a\/(.+?) b\//.exec(chunk);
    if (match?.[1]) result.set(match[1], chunk);
  }
  return result;
}

/** Fails when `git commit` in a fresh repository with the user's global config cannot finish unattended. */
export async function checkUnattendedCommit(stateDir: string): Promise<string | undefined> {
  const probe = join(stateDir, "commit-probe");
  rmSync(probe, { recursive: true, force: true });
  mkdirSync(probe, { recursive: true });

  try {
    await git(probe, ["init", "-q"]);
    const result = await run("git", ["commit", "--allow-empty", "-q", "-m", "probe"], {
      cwd: probe,
      env: { GIT_TERMINAL_PROMPT: "0", GPG_TTY: "", SSH_ASKPASS: "", DISPLAY: "" },
      timeout: 15_000,
    });
    if (result.code === 0) return undefined;
    return `git commit не проходит без участия человека (подпись коммита или identity): ${(result.stderr || result.stdout).trim()}`;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
