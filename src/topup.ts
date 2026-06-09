import { loadConfig, getRepo } from "./config.js";
import {
  withState,
  worktreesForRepo,
  removeWorktree,
  type State,
  type Worktree,
} from "./state.js";
import {
  buildWorktree,
  resetupWorktree,
  removeWorktreeDir,
  worktreeExistsOnDisk,
} from "./worktree.js";
import { now } from "./time.js";

/**
 * Bring a repo's `ready` pool up to poolSize. Re-sets-up released worktrees
 * first (cheap, keeps node_modules), then builds new ones as needed. Runs
 * synchronously; invoked in the foreground (prewarm) or in a detached bg
 * process (after up/down).
 */
export async function topupRepo(repoName: string): Promise<void> {
  const config = loadConfig();
  const repo = getRepo(config, repoName);

  for (;;) {
    // Decide the next action under the lock, then do slow work outside it.
    const action = await withState((state): TopupAction => {
      const wts = worktreesForRepo(state, repoName);
      const ready = wts.filter((w) => w.status === "ready").length;
      const building = wts.filter((w) => w.status === "building").length;
      const projected = ready + building;

      // Destroy excess released worktrees beyond capacity.
      const releasable = wts.filter((w) => w.status === "needs-resetup");
      if (projected >= repo.poolSize && releasable.length > 0) {
        const victim = releasable[0];
        victim.status = "building"; // claim so nobody else touches it
        return { kind: "destroy", wt: victim };
      }

      if (projected >= repo.poolSize) return { kind: "done" };

      // Prefer reusing a released worktree over building fresh.
      const reuse = releasable[0];
      if (reuse) {
        reuse.status = "building";
        return { kind: "resetup", wt: reuse };
      }

      // Build a brand new one. Reserve a placeholder so concurrent top-ups
      // don't overshoot.
      const placeholder: Worktree = {
        id: `pending-${Math.random().toString(36).slice(2, 6)}`,
        repo: repoName,
        path: "",
        status: "building",
        branch: null,
        owner: null,
        baseCommit: null,
        warmedAt: null,
        attachedAt: null,
      };
      state.worktrees.push(placeholder);
      return { kind: "build", placeholderId: placeholder.id };
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
          }
        });
      } catch (err) {
        // Reset failed; tear it down so it doesn't get stuck.
        removeWorktreeDir(repo, action.wt);
        await withState((state) => removeWorktree(state, action.wt.id));
      }
      continue;
    }

    if (action.kind === "build") {
      try {
        const built = buildWorktree(config, repoName, repo);
        await withState((state) => {
          const w = state.worktrees.find((x) => x.id === action.placeholderId);
          if (w) {
            w.id = built.id;
            w.path = built.path;
            w.status = "ready";
            w.baseCommit = built.baseCommit;
            w.warmedAt = now();
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

  // Opportunistic cleanup of records whose dirs vanished.
  await withState((state) => {
    for (const w of worktreesForRepo(state, repoName)) {
      if (w.path && w.status !== "building" && !worktreeExistsOnDisk(w)) {
        removeWorktree(state, w.id);
      }
    }
  });
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
