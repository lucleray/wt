import { loadConfig, getRepo, validateRepo, configPath } from "./config.js";
import {
  withState,
  readState,
  worktreesForRepo,
  findById,
  findByPath,
  type Worktree,
} from "./state.js";
import {
  buildWorktree,
  checkoutBranch,
  detach,
  pruneSource,
  worktreeExistsOnDisk,
} from "./worktree.js";
import { topupRepo } from "./topup.js";
import { reconcile } from "./reconcile.js";
import { spawnDetached, humanAge, tildify } from "./util.js";
import { now } from "./time.js";

export interface CmdOpts {
  json?: boolean;
  pathOnly?: boolean;
  skipSetup?: boolean;
}

function out(json: boolean | undefined, data: unknown, human: string): void {
  if (json) process.stdout.write(JSON.stringify(data) + "\n");
  else if (human) process.stdout.write(human + "\n");
}

/** Spawn a detached background top-up for a repo. */
function triggerTopup(repo: string): void {
  const self = process.argv[1];
  spawnDetached(process.execPath, [self, "__topup", repo]);
}

// ---- up ----

export async function cmdUp(
  repoName: string,
  branch: string | undefined,
  opts: CmdOpts,
): Promise<void> {
  const config = loadConfig();
  const repo = getRepo(config, repoName);

  // Clean up any crashed/stale worktrees before handing one out.
  await reconcile(config);

  // Try to claim a ready worktree under the lock.
  let claimed = await withState((state): Worktree | null => {
    const ready = worktreesForRepo(state, repoName).find(
      (w) => w.status === "ready" && worktreeExistsOnDisk(w),
    );
    if (!ready) return null;
    ready.status = "attached";
    ready.owner = process.cwd();
    ready.attachedAt = now();
    return { ...ready };
  });

  let cold = false;
  if (!claimed) {
    // Cold start: build one now.
    cold = true;
    if (!opts.json && !opts.pathOnly) {
      process.stderr.write(
        `no warm worktree ready for "${repoName}", building one (cold start)...\n`,
      );
    }
    if (opts.skipSetup && !opts.json && !opts.pathOnly && repo.setup) {
      process.stderr.write(
        `--skip-setup: not running "${repo.setup}" — run it yourself in the worktree.\n`,
      );
    }
    const built = buildWorktree(config, repoName, repo, opts.skipSetup);
    claimed = await withState((state): Worktree => {
      const wt: Worktree = {
        id: built.id,
        repo: repoName,
        path: built.path,
        status: "attached",
        branch: null,
        owner: process.cwd(),
        baseCommit: built.baseCommit,
        warmedAt: now(),
        attachedAt: now(),
        workerPid: null,
        enteredAt: null,
      };
      state.worktrees.push(wt);
      return { ...wt };
    });
  }

  // Optionally create a branch.
  if (branch) {
    checkoutBranch(claimed, branch);
    await withState((state) => {
      const w = findById(state, claimed!.id);
      if (w) w.branch = branch;
    });
    claimed.branch = branch;
  }

  // Top up the pool in the background.
  triggerTopup(repoName);

  if (opts.pathOnly) {
    process.stdout.write(claimed.path + "\n");
    return;
  }

  const warmedNote =
    !cold && claimed.warmedAt ? ` (warmed ${humanAge(claimed.warmedAt)})` : "";
  out(
    opts.json,
    {
      id: claimed.id,
      repo: repoName,
      path: claimed.path,
      branch: claimed.branch,
      cold,
      warmedAt: claimed.warmedAt,
    },
    `${claimed.path}${warmedNote}` +
      (cold ? "" : "") +
      (claimed.branch ? `\nbranch: ${claimed.branch}` : "\n(detached — create a branch with: git switch -c <name>)"),
  );
}

// ---- down ----

export async function cmdDown(
  idOrNothing: string | undefined,
  opts: CmdOpts,
): Promise<void> {
  const target = await withState((state): Worktree | null => {
    let wt: Worktree | undefined;
    if (idOrNothing) {
      wt = findById(state, idOrNothing);
      if (!wt) throw new Error(`no worktree with id "${idOrNothing}"`);
    } else {
      wt = findByPath(state, process.cwd());
      if (!wt) {
        throw new Error(
          `not inside a managed worktree (cwd: ${process.cwd()}). Pass an id: wt down <id>`,
        );
      }
    }
    wt.status = "needs-resetup";
    wt.owner = null;
    wt.attachedAt = null;
    wt.workerPid = null;
    wt.enteredAt = null;
    return { ...wt };
  });

  if (!target) return;

  // Detach HEAD so the branch isn't held; cheap, safe to do in foreground.
  detach(target);

  triggerTopup(target.repo);

  out(
    opts.json,
    { id: target.id, repo: target.repo, released: true },
    `released ${target.id} (${target.repo}) — returning to pool`,
  );
}

// ---- list ----

/** Human-friendly label for a worktree status. */
function statusLabel(status: string): string {
  switch (status) {
    case "ready":
      return "ready";
    case "attached":
      return "in use";
    case "needs-resetup":
      return "recycling";
    case "building":
      return "building";
    case "resetting":
      return "building";
    case "destroying":
      return "removing";
    default:
      return status;
  }
}

/**
 * Branch column. A worktree with a checked-out branch shows it. Otherwise it's
 * detached at the base branch's commit, so show e.g. "main~" to convey "based
 * on <base>, no branch yet".
 */
function branchLabel(w: { branch: string | null }, baseBranch: string): string {
  if (w.branch) return w.branch;
  return `${baseBranch}~`;
}

export async function cmdList(
  repoName: string | undefined,
  opts: CmdOpts,
): Promise<void> {
  const config = loadConfig();
  const state = readState();
  // Include everything, even in-flight builds (pending placeholders).
  let wts = [...state.worktrees];
  if (repoName) wts = wts.filter((w) => w.repo === repoName);

  // Sort: group by repo, then ready first, then by age.
  const order = ["ready", "attached", "needs-resetup", "resetting", "building", "destroying"];
  wts.sort((a, b) => {
    if (a.repo !== b.repo) return a.repo.localeCompare(b.repo);
    const oa = order.indexOf(a.status);
    const ob = order.indexOf(b.status);
    if (oa !== ob) return oa - ob;
    return (b.warmedAt ?? 0) - (a.warmedAt ?? 0);
  });

  if (opts.json) {
    out(true, wts, "");
    return;
  }
  if (wts.length === 0) {
    process.stdout.write("no worktrees — run `wt up <repo>` to get one\n");
    return;
  }
  const rows = wts.map((w) => [
    w.id.startsWith("pending-") ? "—" : w.id,
    w.repo,
    statusLabel(w.status),
    branchLabel(w, config.repos[w.repo]?.baseBranch ?? "main"),
    w.warmedAt ? humanAge(w.warmedAt) : "—",
    w.path ? tildify(w.path) : "(building)",
  ]);
  printTable(["ID", "REPO", "STATUS", "BRANCH", "AGE", "PATH"], rows);
}

// ---- prewarm ----

export async function cmdPrewarm(
  repoName: string,
  opts: CmdOpts,
): Promise<void> {
  const config = loadConfig();
  getRepo(config, repoName); // validate exists
  // Run top-up in the foreground so the user sees progress/errors.
  if (!opts.json) {
    process.stdout.write(`warming pool for "${repoName}"...\n`);
  }
  await topupRepo(repoName);
  const state = readState();
  const ready = worktreesForRepo(state, repoName).filter(
    (w) => w.status === "ready",
  ).length;
  out(opts.json, { repo: repoName, ready }, `pool ready: ${ready} worktree(s)`);
}

// ---- gc ----

export async function cmdGc(opts: CmdOpts): Promise<void> {
  const config = loadConfig();
  // reconcile() handles both stale transitional (crashed) records and records
  // whose worktree dir vanished, cleaning up state + disk together.
  const removed = await reconcile(config);
  for (const [, repo] of Object.entries(config.repos)) {
    pruneSource(repo);
  }
  out(
    opts.json,
    { removed },
    removed.length
      ? `pruned ${removed.length} stale worktree(s): ${removed.join(", ")}`
      : "nothing to prune",
  );
}

// ---- config ----

export async function cmdConfig(opts: CmdOpts): Promise<void> {
  const config = loadConfig();
  const validations = Object.entries(config.repos).map(([name, repo]) =>
    validateRepo(name, repo),
  );

  if (opts.json) {
    out(true, { configPath: configPath(), config, validations }, "");
    return;
  }

  // Header: where config + worktrees live.
  process.stdout.write("\n");
  process.stdout.write(`  config    ${tildify(configPath())}\n`);
  process.stdout.write(`  worktrees ${tildify(config.worktreeRoot)}\n\n`);

  // Repo table.
  const repos = Object.entries(config.repos);
  if (repos.length === 0) {
    process.stdout.write("  no repos configured — see docs/config.md\n");
    return;
  }
  const ok = (name: string) => validations.find((v) => v.name === name)?.ok;
  const rows = repos.map(([name, repo]) => [
    ok(name) ? "✓" : "✗",
    name,
    repo.baseBranch,
    `${repo.minPool}–${repo.maxPool}`,
    repo.setup ?? "—",
    tildify(repo.source),
  ]);
  printTable(["", "REPO", "BASE", "POOL", "SETUP", "SOURCE"], rows, "  ");

  // Any validation problems, called out below.
  const broken = validations.filter((v) => !v.ok);
  if (broken.length) {
    process.stdout.write("\n  problems:\n");
    for (const v of broken) {
      for (const p of v.problems) {
        process.stdout.write(`    ✗ ${v.name}: ${p}\n`);
      }
    }
  }
  process.stdout.write("\n");
}

// ---- internal: __topup ----

export async function cmdTopup(repoName: string): Promise<void> {
  await topupRepo(repoName);
}

// ---- table helper ----

function printTable(
  header: string[],
  rows: string[][],
  indent = "",
): void {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const fmt = (cols: string[]) =>
    indent + cols.map((c, i) => c.padEnd(widths[i])).join("  ").replace(/\s+$/, "");
  process.stdout.write(fmt(header) + "\n");
  for (const r of rows) process.stdout.write(fmt(r) + "\n");
}
