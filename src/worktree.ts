import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { run, runOrThrow, runShell, shortId } from "./util.js";
import type { Config, RepoConfig } from "./config.js";
import type { Worktree } from "./state.js";

export interface BuildResult {
  id: string;
  path: string;
  baseCommit: string;
}

/** Fetch the source repo so the base branch is current. */
export function fetchSource(repo: RepoConfig): void {
  // Best-effort; don't fail a build if offline.
  run("git", ["-C", repo.source, "fetch", "origin", "--quiet"]);
}

function baseRef(repo: RepoConfig): string {
  // Prefer origin/<base> if it exists, else local <base>.
  const remote = run("git", [
    "-C",
    repo.source,
    "rev-parse",
    "--verify",
    "--quiet",
    `origin/${repo.baseBranch}`,
  ]);
  return remote.code === 0 ? `origin/${repo.baseBranch}` : repo.baseBranch;
}

function resolveCommit(repo: RepoConfig, ref: string): string {
  return runOrThrow("git", ["-C", repo.source, "rev-parse", ref]).slice(0, 12);
}

/**
 * Create a detached worktree at the base branch and run the setup script.
 * Returns the new worktree metadata. Throws on failure (caller cleans up state).
 */
export function buildWorktree(
  config: Config,
  repoName: string,
  repo: RepoConfig,
): BuildResult {
  fetchSource(repo);
  const ref = baseRef(repo);
  const id = shortId();
  const dir = join(config.worktreeRoot, repoName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `wt-${id}`);

  runOrThrow("git", [
    "-C",
    repo.source,
    "worktree",
    "add",
    "--detach",
    path,
    ref,
  ]);

  const baseCommit = resolveCommit(repo, ref);
  runSetup(repo, path);

  return { id, path, baseCommit };
}

/** Reset an existing worktree back to base and re-run setup (reuse path). */
export function resetupWorktree(repo: RepoConfig, wt: Worktree): string {
  fetchSource(repo);
  const ref = baseRef(repo);
  runOrThrow("git", ["-C", wt.path, "fetch", "origin", "--quiet"]);
  runOrThrow("git", ["-C", wt.path, "checkout", "--detach", ref]);
  runOrThrow("git", ["-C", wt.path, "reset", "--hard", ref]);
  // Clean untracked files but preserve ignored ones (node_modules etc).
  runOrThrow("git", ["-C", wt.path, "clean", "-fd"]);
  runSetup(repo, wt.path);
  return resolveCommit(repo, ref);
}

function runSetup(repo: RepoConfig, cwd: string): void {
  if (!repo.setup) return;
  const res = runShell(repo.setup, { cwd });
  if (res.code !== 0) {
    throw new Error(
      `setup script failed in ${cwd}:\n$ ${repo.setup}\n${res.stderr.trim()}`,
    );
  }
}

/** Create + checkout a branch in a worktree (used by `up <repo> <branch>`). */
export function checkoutBranch(wt: Worktree, branch: string): void {
  runOrThrow("git", ["-C", wt.path, "switch", "-c", branch]);
}

/** Detach a worktree's HEAD (used on release). */
export function detach(wt: Worktree): void {
  run("git", ["-C", wt.path, "checkout", "--detach"]);
}

/** Remove a worktree from disk + git's registry. */
export function removeWorktreeDir(repo: RepoConfig, wt: Worktree): void {
  run("git", ["-C", repo.source, "worktree", "remove", "--force", wt.path]);
  run("git", ["-C", repo.source, "worktree", "prune"]);
}

export function pruneSource(repo: RepoConfig): void {
  run("git", ["-C", repo.source, "worktree", "prune"]);
}

export function worktreeExistsOnDisk(wt: Worktree): boolean {
  return existsSync(wt.path);
}
