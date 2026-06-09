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
import { spawnDetached, humanAge } from "./util.js";
import { now } from "./time.js";

export interface CmdOpts {
  json?: boolean;
  pathOnly?: boolean;
  n?: number;
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
    const built = buildWorktree(config, repoName, repo);
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

export async function cmdList(
  repoName: string | undefined,
  opts: CmdOpts,
): Promise<void> {
  const state = readState();
  let wts = state.worktrees.filter((w) => !w.id.startsWith("pending-"));
  if (repoName) wts = wts.filter((w) => w.repo === repoName);

  if (opts.json) {
    out(true, wts, "");
    return;
  }
  if (wts.length === 0) {
    process.stdout.write("no worktrees\n");
    return;
  }
  const rows = wts.map((w) => ({
    id: w.id,
    repo: w.repo,
    status: w.status,
    branch: w.branch ?? "(detached)",
    age: w.warmedAt ? humanAge(w.warmedAt) : "-",
    path: w.path,
  }));
  const header = ["ID", "REPO", "STATUS", "BRANCH", "AGE", "PATH"];
  printTable(header, rows.map((r) => [r.id, r.repo, r.status, r.branch, r.age, r.path]));
}

// ---- status ----

export async function cmdStatus(opts: CmdOpts): Promise<void> {
  const config = loadConfig();
  const state = readState();
  const report = Object.entries(config.repos).map(([name, repo]) => {
    const wts = worktreesForRepo(state, name).filter(
      (w) => !w.id.startsWith("pending-"),
    );
    return {
      repo: name,
      ready: wts.filter((w) => w.status === "ready").length,
      attached: wts.filter((w) => w.status === "attached").length,
      needsResetup: wts.filter((w) => w.status === "needs-resetup").length,
      building: state.worktrees.filter(
        (w) => w.repo === name && w.status === "building",
      ).length,
      target: repo.poolSize,
    };
  });

  if (opts.json) {
    out(true, report, "");
    return;
  }
  const header = ["REPO", "READY", "ATTACHED", "PENDING", "BUILDING", "TARGET"];
  printTable(
    header,
    report.map((r) => [
      r.repo,
      String(r.ready),
      String(r.attached),
      String(r.needsResetup),
      String(r.building),
      String(r.target),
    ]),
  );
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
  process.stdout.write(`config: ${configPath()}\n`);
  process.stdout.write(`worktreeRoot: ${config.worktreeRoot}\n\n`);
  for (const v of validations) {
    const repo = config.repos[v.name];
    const mark = v.ok ? "ok" : "PROBLEM";
    process.stdout.write(
      `[${mark}] ${v.name}\n  source: ${repo.source}\n  base: ${repo.baseBranch}  pool: ${repo.poolSize}  setup: ${repo.setup ?? "(none)"}\n`,
    );
    for (const p of v.problems) process.stdout.write(`  - ${p}\n`);
  }
}

// ---- internal: __topup ----

export async function cmdTopup(repoName: string): Promise<void> {
  await topupRepo(repoName);
}

// ---- table helper ----

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const fmt = (cols: string[]) =>
    cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  process.stdout.write(fmt(header) + "\n");
  for (const r of rows) process.stdout.write(fmt(r) + "\n");
}
