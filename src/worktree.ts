import { mkdirSync, existsSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { run, runOrThrow, runShell, shortId } from "./util.js";
import { withNamedLockSync } from "./state.js";
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
 * Pass `skipSetup` to check out the worktree without running the setup script
 * (e.g. on a bad connection where `pnpm install` can't succeed).
 */
export function buildWorktree(
  config: Config,
  slug: string,
  repo: RepoConfig,
  skipSetup = false,
): BuildResult {
  fetchSource(repo);
  const ref = baseRef(repo);
  const id = shortId();
  const dir = join(config.worktreeRoot, slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `wt-${id}`);

  // Serialize `git worktree add` per source repo: concurrent adds race on the
  // shared .git lock. The setup script runs outside the lock so installs can
  // still proceed in parallel.
  const baseCommit = withNamedLockSync(`git-${slug}`, () => {
    runOrThrow("git", [
      "-C",
      repo.source,
      "worktree",
      "add",
      "--detach",
      path,
      ref,
    ]);
    return resolveCommit(repo, ref);
  });
  if (!skipSetup) runSetup(repo, path);

  return { id, path, baseCommit };
}

/** Reset an existing worktree back to base and re-run setup (reuse path). */
export function resetupWorktree(repo: RepoConfig, wt: Worktree): string {
  fetchSource(repo);
  const ref = baseRef(repo);
  // Fetch in the worktree is best-effort: repos without an `origin` remote
  // (or while offline) should still reset to the local base ref.
  run("git", ["-C", wt.path, "fetch", "origin", "--quiet"]);
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
  withNamedLockSync(`git-${wt.repo}`, () => {
    if (wt.path) {
      // Try the clean git path first (handles registered worktrees).
      run("git", ["-C", repo.source, "worktree", "remove", "--force", wt.path]);
      // If the dir still exists (e.g. a half-built worktree git never
      // registered, or removal failed), force-delete it from disk.
      if (existsSync(wt.path)) {
        try {
          rmSync(wt.path, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    }
    run("git", ["-C", repo.source, "worktree", "prune"]);
  });
}

export function pruneSource(repo: RepoConfig): void {
  run("git", ["-C", repo.source, "worktree", "prune"]);
}

export function worktreeExistsOnDisk(wt: Worktree): boolean {
  return existsSync(wt.path);
}

/**
 * List the absolute paths of worktrees git knows about for a source repo,
 * excluding the main worktree itself.
 */
export function listGitWorktrees(repo: RepoConfig): string[] {
  const res = run("git", [
    "-C",
    repo.source,
    "worktree",
    "list",
    "--porcelain",
  ]);
  if (res.code !== 0) return [];
  const paths: string[] = [];
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      const p = line.slice("worktree ".length).trim();
      paths.push(p);
    }
  }
  // First entry is the main worktree (the source repo itself); drop it.
  const mainReal = realpathSafe(repo.source);
  return paths.filter((p) => realpathSafe(p) !== mainReal);
}

/** Force-remove a worktree by path (orphan with no state record). */
export function removeOrphanPath(repo: RepoConfig, path: string): void {
  run("git", ["-C", repo.source, "worktree", "remove", "--force", path]);
  if (existsSync(path)) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  run("git", ["-C", repo.source, "worktree", "prune"]);
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
