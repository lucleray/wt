import { loadConfig, type Config, type RepoConfig } from "./config.js";
import {
  withState,
  worktreesForRepo,
  removeWorktree,
  tryNamedLock,
  type State,
  type Worktree,
} from "./state.js";
import {
  buildWorktree,
  resetupWorktree,
  removeWorktreeDir,
} from "./worktree.js";
import { resolveRepo } from "./repo.js";
import { now } from "./time.js";

/**
 * Rebalance a repo's pool against three bounds:
 *   - minWarmPool  — warm floor (kept implicitly: we build toward the warm cap).
 *   - maxWarmPool  — warm ceiling: pre-build up to this many `ready` worktrees.
 *   - maxTotalPool — total ceiling: never grow the on-disk pool beyond this.
 * Re-sets-up released worktrees first (cheap, keeps node_modules), then builds
 * new ones as needed; destroys released worktrees that exceed a ceiling.
 * Runs synchronously; invoked in the foreground (prewarm) or in a detached bg
 * process (after up/down). `token` is a source path or alias.
 */
export async function topupRepo(token: string): Promise<void> {
  const config = loadConfig();
  const resolved = resolveRepo(config, token);
  if (!resolved.cfg) return; // not configured — nothing to top up
  const slug = resolved.slug;

  // Serialize top-ups per repo. If one is already running, it will observe the
  // latest state on its next loop iteration, so we can safely no-op here. This
  // prevents concurrent top-ups from racing on git operations in the shared
  // source repo.
  const release = tryNamedLock(`topup-${slug}`);
  if (!release) return;

  try {
    await topupRepoLocked(config, resolved.cfg, slug);
  } finally {
    release();
  }
}

async function topupRepoLocked(
  config: Config,
  repo: RepoConfig,
  slug: string,
): Promise<void> {
  for (;;) {
    // Decide the next action under the lock, then do slow work outside it.
    const action = await withState((state): TopupAction => {
      const wts = worktreesForRepo(state, slug);
      const ready = wts.filter((w) => w.status === "ready").length;
      // Count in-flight builds/resets toward the warm target so we don't
      // overshoot when several top-ups run at once.
      const inflight = wts.filter(
        (w) => w.status === "building" || w.status === "resetting",
      ).length;
      // Total footprint = everything that occupies a worktree on disk.
      // (destroying records are on their way out, so they don't count.)
      const total = wts.filter((w) => w.status !== "destroying").length;

      const warm = ready + inflight; // ready or about-to-be-ready
      const releasable = wts.filter((w) => w.status === "needs-resetup");

      // 1. Scale down: destroy a released worktree when we're over a ceiling —
      //    either the total footprint exceeds maxTotalPool, or the warm pool is
      //    already full (maxWarmPool reached) so recycling this one is wasteful.
      if (releasable.length > 0 && (total > repo.maxTotalPool || warm >= repo.maxWarmPool)) {
        const victim = releasable[0];
        claim(victim, "destroying");
        return { kind: "destroy", wt: { ...victim } };
      }

      // 2. Grow the warm pool toward maxWarmPool. Prefer reusing a released
      //    worktree (cheap reset, keeps node_modules) over building fresh, and
      //    never let the total footprint exceed maxTotalPool.
      if (warm < repo.maxWarmPool) {
        const reuse = releasable[0];
        if (reuse) {
          claim(reuse, "resetting");
          return { kind: "resetup", wt: { ...reuse } };
        }
        if (total < repo.maxTotalPool) {
          const placeholder: Worktree = {
            id: `pending-${Math.random().toString(36).slice(2, 6)}`,
            repo: slug,
            path: "",
            status: "building",
            branch: null,
            owner: null,
            baseCommit: null,
            warmedAt: null,
            attachedAt: null,
            workerPid: process.pid,
            enteredAt: now(),
          };
          state.worktrees.push(placeholder);
          return { kind: "build", placeholderId: placeholder.id };
        }
      }

      return { kind: "done" };
    });

    if (action.kind === "done") break;

    if (action.kind === "destroy") {
      removeWorktreeDir(repo, action.wt);
      await withState((state) => removeWorktree(state, action.wt.id));
      continue;
    }

    if (action.kind === "resetup") {
      try {
        const baseCommit = resetupWorktree(repo, action.wt);
        await withState((state) => {
          const w = state.worktrees.find((x) => x.id === action.wt.id);
          if (w) {
            w.status = "ready";
            w.branch = null;
            w.owner = null;
            w.baseCommit = baseCommit;
            w.warmedAt = now();
            w.attachedAt = null;
            w.workerPid = null;
            w.enteredAt = null;
          }
        });
      } catch {
        // Reset failed; tear it down so it doesn't get stuck.
        try {
          removeWorktreeDir(repo, action.wt);
        } catch {
          /* best effort */
        }
        await withState((state) => removeWorktree(state, action.wt.id));
      }
      continue;
    }

    if (action.kind === "build") {
      try {
        const built = buildWorktree(config, slug, repo);
        await withState((state) => {
          const w = state.worktrees.find((x) => x.id === action.placeholderId);
          if (w) {
            w.id = built.id;
            w.path = built.path;
            w.status = "ready";
            w.baseCommit = built.baseCommit;
            w.warmedAt = now();
            w.workerPid = null;
            w.enteredAt = null;
          }
        });
      } catch (err) {
        await withState((state) =>
          removeWorktree(state, action.placeholderId),
        );
        throw err;
      }
      continue;
    }
  }
}

/** Mark a worktree as claimed for a transitional operation by this worker. */
function claim(wt: Worktree, status: Worktree["status"]): void {
  wt.status = status;
  wt.workerPid = process.pid;
  wt.enteredAt = now();
}

type TopupAction =
  | { kind: "done" }
  | { kind: "build"; placeholderId: string }
  | { kind: "resetup"; wt: Worktree }
  | { kind: "destroy"; wt: Worktree };

export function countReady(state: State, repo: string): number {
  return worktreesForRepo(state, repo).filter((w) => w.status === "ready")
    .length;
}
