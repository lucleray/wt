import { mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run, runAsync, runOrThrow, runShell, shortId } from "./util.js";
import { withNamedLockSync } from "./state.js";
import type { Config, RepoConfig } from "./config.js";
import type { Worktree } from "./state.js";

export interface BuildResult {
  id: string;
  path: string;
  baseCommit: string;
}

/**
 * Drop a `.metadata_never_index` marker at the pool root so macOS Spotlight
 * skips the entire worktree tree. The pool churns constantly (fresh checkouts +
 * installs), and indexing thousands of `node_modules` files gives no search
 * value while pinning `mds_stores`/`fseventsd` at high CPU (fans + battery).
 * Best-effort and idempotent: harmless/no-op on non-macOS or if perms fail.
 */
function ensureSpotlightExcluded(root: string): void {
  const marker = join(root, ".metadata_never_index");
  if (existsSync(marker)) return;
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(marker, "");
  } catch {
    /* best effort */
  }
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
  ensureSpotlightExcluded(config.worktreeRoot);
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
  enableUntrackedCache(path);
  if (!skipSetup) runSetup(repo, path);

  return { id, path, baseCommit };
}

/**
 * Enable git's untracked cache for a worktree so later `git status` calls
 * (notably `wt list` and `wt down`'s safety check) don't re-stat the entire
 * working tree — they reuse cached results for unchanged directories. Worktrees
 * carry huge ignored trees (node_modules etc), so this turns repeat status
 * reads from a full filesystem walk into a near-no-op. The cache is purely an
 * accuracy-preserving optimization; best-effort, so ignore failures.
 */
function enableUntrackedCache(path: string): void {
  run("git", ["-C", path, "config", "core.untrackedCache", "true"]);
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
  enableUntrackedCache(wt.path);
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

export function worktreeExistsOnDisk(wt: Worktree): boolean {
  return existsSync(wt.path);
}

export interface HeadInfo {
  /** Checked-out branch name, or null if HEAD is detached. */
  branch: string | null;
  /** Short commit HEAD points at, or null if it can't be read. */
  commit: string | null;
  /** Uncommitted changes present (tracked or untracked). */
  dirty: boolean;
  /** Whether the branch has a configured upstream. */
  hasUpstream: boolean;
  /** Commits ahead of upstream (0 if none / no upstream). */
  ahead: number;
  /** Commits behind upstream (0 if none / no upstream). */
  behind: number;
}

export const EMPTY_HEAD: HeadInfo = {
  branch: null,
  commit: null,
  dirty: false,
  hasUpstream: false,
  ahead: 0,
  behind: 0,
};

/**
 * Read a worktree's *live* git state straight from disk, so we never trust the
 * possibly-stale `branch` recorded in state (the user may have run
 * `git switch -c` and committed after we handed the worktree out). Returns the
 * checked-out branch (if any), the short commit, whether the tree is dirty, and
 * upstream ahead/behind counts. Uses a single `git status` so it stays cheap.
 */
export function headInfo(path: string): HeadInfo {
  if (!path || !existsSync(path)) return { ...EMPTY_HEAD };

  // One call gives branch, upstream, ahead/behind, and dirty state.
  const res = run("git", ["-C", path, "status", "--porcelain=v2", "--branch"]);
  if (res.code !== 0) {
    // Fall back to a bare HEAD read (e.g. brand-new repo with no commits).
    const rev = run("git", ["-C", path, "rev-parse", "--short", "HEAD"]);
    return headFallback(rev.code === 0 ? rev.stdout : null);
  }
  return parsePorcelainV2(res.stdout);
}

/** A worktree's branch identity, without the cost of a working-tree scan. */
export interface BranchInfo {
  /** Checked-out branch name, or null if HEAD is detached. */
  branch: string | null;
  /** Short commit HEAD points at, or null if it can't be read. */
  commit: string | null;
  /** Commits ahead of upstream (0 if none / no upstream). */
  ahead: number;
  /** Commits behind upstream (0 if none / no upstream). */
  behind: number;
}

/**
 * Read just a worktree's branch identity (branch, commit, ahead/behind) using
 * git plumbing, with no `git status`. `wt list` only displays this, and the
 * working-tree scan that `git status` does to detect dirtiness is by far the
 * most expensive part — skipping it makes listing many worktrees cheap. Async
 * so callers can fan reads out concurrently. (`wt down`'s safety check still
 * uses the full `headInfo` to refuse releasing unsaved work.)
 */
export async function branchInfoAsync(path: string): Promise<BranchInfo> {
  const empty: BranchInfo = { branch: null, commit: null, ahead: 0, behind: 0 };
  if (!path || !existsSync(path)) return empty;

  // symbolic-ref succeeds only when a branch is checked out; a non-zero exit
  // means HEAD is detached, which we represent as a null branch.
  const [ref, rev, ab] = await Promise.all([
    runAsync("git", ["-C", path, "symbolic-ref", "--short", "-q", "HEAD"]),
    runAsync("git", ["-C", path, "rev-parse", "--short", "HEAD"]),
    runAsync("git", ["-C", path, "rev-list", "--count", "--left-right", "@{u}...HEAD"]),
  ]);

  const branch = ref.code === 0 ? ref.stdout.trim() || null : null;
  const commit = rev.code === 0 ? rev.stdout.trim() || null : null;
  let ahead = 0;
  let behind = 0;
  if (ab.code === 0) {
    // Output: "<behind>\t<ahead>" for @{u}...HEAD (left = upstream-only).
    const m = ab.stdout.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) {
      behind = parseInt(m[1], 10);
      ahead = parseInt(m[2], 10);
    }
  }
  return { branch, commit, ahead, behind };
}

/** HeadInfo for the no-commits / status-failed case: best-effort short commit. */
function headFallback(revStdout: string | null): HeadInfo {
  return {
    ...EMPTY_HEAD,
    commit: revStdout ? revStdout.trim() || null : null,
  };
}

/** Parse `git status --porcelain=v2 --branch` output into a HeadInfo. */
function parsePorcelainV2(stdout: string): HeadInfo {
  let branch: string | null = null;
  let commit: string | null = null;
  let hasUpstream = false;
  let ahead = 0;
  let behind = 0;
  let dirty = false;

  for (const line of stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const v = line.slice("# branch.head ".length).trim();
      branch = v === "(detached)" ? null : v;
    } else if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length).trim();
      commit = oid === "(initial)" ? null : oid.slice(0, 11);
    } else if (line.startsWith("# branch.upstream ")) {
      hasUpstream = true;
    } else if (line.startsWith("# branch.ab ")) {
      // Format: "# branch.ab +<ahead> -<behind>"
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        ahead = parseInt(m[1], 10);
        behind = parseInt(m[2], 10);
      }
    } else if (line && !line.startsWith("#")) {
      // Any non-header line is a changed/untracked/unmerged entry.
      dirty = true;
    }
  }

  return { branch, commit, dirty, hasUpstream, ahead, behind };
}

