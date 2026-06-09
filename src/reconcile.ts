import {
  withState,
  removeWorktree,
  isTransitional,
  type Worktree,
} from "./state.js";
import {
  removeWorktreeDir,
  worktreeExistsOnDisk,
  listGitWorktrees,
  removeOrphanPath,
} from "./worktree.js";
import { loadConfig, type Config } from "./config.js";
import { now } from "./time.js";
import { realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * Default age (seconds) after which a transitional record with no live worker
 * is considered crashed. Builds/installs can legitimately take a while, so this
 * is generous; the PID check reclaims dead workers immediately regardless.
 */
const STALE_AFTER_SECONDS = 30 * 60;

/** Resolve symlinks (e.g. macOS /var -> /private/var) when the path exists. */
function realish(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function pidAlive(pid: number | null): boolean {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A transitional record is stale if its worker is dead OR it's too old. */
function isStale(wt: Worktree): boolean {
  if (!isTransitional(wt.status)) return false;
  if (pidAlive(wt.workerPid)) return false; // worker still running, leave it
  // No live worker. If we recorded a pid that's now dead, reclaim immediately.
  if (wt.workerPid && !pidAlive(wt.workerPid)) return true;
  // No pid recorded (legacy/placeholder) — fall back to age.
  const age = now() - (wt.enteredAt ?? wt.warmedAt ?? 0);
  return age > STALE_AFTER_SECONDS;
}

/**
 * Decide whether a record should be cleaned up.
 *
 * A transitional record with a *live* worker is always protected — its dir may
 * not exist yet because the build is still in progress. Otherwise we clean up
 * stale transitional records (crashed mid-operation) and settled records whose
 * worktree dir has vanished.
 */
function shouldClean(wt: Worktree): boolean {
  if (isTransitional(wt.status)) {
    // Protected while a worker is actively running; else clean if stale.
    return isStale(wt);
  }
  // Settled record (ready/attached/needs-resetup): clean if its dir is gone.
  return Boolean(wt.path) && !worktreeExistsOnDisk(wt);
}

/**
 * Reconcile state vs. reality. Cleans up:
 *  - stale transitional records (crashed mid build/reset/destroy) + their dirs
 *  - records whose worktree dir no longer exists on disk
 * Safe to call before any command. Returns the ids that were cleaned up.
 */
export async function reconcile(config?: Config): Promise<string[]> {
  const cfg = config ?? loadConfig();
  const cleaned: string[] = [];

  // First, snapshot which records need cleanup (under lock), and claim them so
  // concurrent reconciles don't double-act.
  const toClean = await withState((state): Worktree[] => {
    const victims: Worktree[] = [];
    for (const wt of [...state.worktrees]) {
      if (shouldClean(wt)) {
        victims.push({ ...wt });
        // Mark as destroying so nobody hands it out / re-acts on it.
        const live = state.worktrees.find((w) => w.id === wt.id);
        if (live) {
          live.status = "destroying";
          live.workerPid = process.pid;
          live.enteredAt = now();
        }
      }
    }
    return victims;
  });

  // Do the slow filesystem cleanup outside the lock.
  for (const wt of toClean) {
    const repo = cfg.repos[wt.repo];
    if (repo && wt.path && worktreeExistsOnDisk(wt)) {
      try {
        removeWorktreeDir(repo, wt);
      } catch {
        /* best effort */
      }
    }
    await withState((state) => removeWorktree(state, wt.id));
    cleaned.push(wt.id);
  }

  // Reverse sweep: worktrees git/disk know about but wt's state does not
  // (e.g. a build that created the worktree then crashed before recording it).
  cleaned.push(...(await sweepOrphans(cfg)));

  return cleaned;
}

/**
 * Find worktrees under each repo's pool dir that git knows about but have no
 * backing state record, and remove them. Only touches paths inside the managed
 * worktreeRoot/<repo>/ tree, so it never disturbs unrelated worktrees.
 */
async function sweepOrphans(cfg: Config): Promise<string[]> {
  const removed: string[] = [];
  // Snapshot the set of known paths from state.
  const known = new Set<string>();
  await withState((state) => {
    for (const w of state.worktrees) {
      if (w.path) known.add(realish(w.path));
    }
  });

  for (const [repoName, repo] of Object.entries(cfg.repos)) {
    const poolDir = realish(join(cfg.worktreeRoot, repoName));
    for (const gitPath of listGitWorktrees(repo)) {
      const real = realish(gitPath);
      // Only manage paths inside this repo's pool dir.
      if (real !== poolDir && !real.startsWith(poolDir + "/")) continue;
      if (known.has(real)) continue;
      try {
        removeOrphanPath(repo, gitPath);
        removed.push(`orphan:${gitPath.split("/").pop()}`);
      } catch {
        /* best effort */
      }
    }
  }
  return removed;
}
