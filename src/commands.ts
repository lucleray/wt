import {
  loadConfig,
  validateRepo,
  configPath,
  writeRepoConfig,
  repoLabel,
  DEFAULT_MIN_WARM,
  DEFAULT_MAX_WARM,
  DEFAULT_MAX_TOTAL,
  DEFAULT_BASE,
  type Config,
  type RepoConfig,
} from "./config.js";
import { resolveRepo, repoSlug, sourceForSlug, looksLikePath } from "./repo.js";
import { suggestSetup } from "./suggest.js";
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
  detach,
  worktreeExistsOnDisk,
  headInfo,
  EMPTY_HEAD,
  type HeadInfo,
} from "./worktree.js";
import { topupRepo } from "./topup.js";
import {
  spawnDetached,
  humanAge,
  tildify,
  expandPath,
  isInteractive,
  prompt,
  run,
} from "./util.js";
import { now } from "./time.js";

export interface CmdOpts {
  json?: boolean;
  pathOnly?: boolean;
  skipSetup?: boolean;
  force?: boolean;
  // `wt config <repo>` setters (non-interactive / agent mode):
  source?: string;
  name?: string;
  baseBranch?: string;
  setup?: string;
  noSetup?: boolean;
  minWarmPool?: number;
  maxWarmPool?: number;
  maxTotalPool?: number;
  yes?: boolean;
}

/** Compact pool-bounds label for tables: "warm min–max / total", e.g. "1–5/25". */
function poolLabel(repo: RepoConfig): string {
  return `${repo.minWarmPool}–${repo.maxWarmPool}/${repo.maxTotalPool}`;
}

function out(json: boolean | undefined, data: unknown, human: string): void {
  if (json) process.stdout.write(JSON.stringify(data) + "\n");
  else if (human) process.stdout.write(human + "\n");
}

/** Spawn a detached background top-up for a repo (by source path). */
function triggerTopup(source: string): void {
  const self = process.argv[1];
  spawnDetached(process.execPath, [self, "__topup", source]);
}

// ---- up ----

export async function cmdUp(
  token: string,
  opts: CmdOpts,
): Promise<void> {
  let config = loadConfig();
  let resolved = resolveRepo(config, token);

  // Unconfigured path → offer/auto set it up, then continue.
  if (!resolved.cfg) {
    await ensureConfigured(resolved.source, opts);
    config = loadConfig();
    resolved = resolveRepo(config, resolved.source);
    if (!resolved.cfg) return; // setup aborted
  }
  const repo = resolved.cfg;
  const slug = resolved.slug;

  // Try to claim a ready worktree under the lock.
  let claimed = await withState((state): Worktree | null => {
    const ready = worktreesForRepo(state, slug).find(
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
        `no warm worktree ready for "${repoLabel(repo)}", building one (cold start)...\n`,
      );
    }
    if (opts.skipSetup && !opts.json && !opts.pathOnly && repo.setup) {
      process.stderr.write(
        `--skip-setup: not running "${repo.setup}" — run it yourself in the worktree.\n`,
      );
    }
    const built = buildWorktree(config, slug, repo, opts.skipSetup);
    claimed = await withState((state): Worktree => {
      const wt: Worktree = {
        id: built.id,
        repo: slug,
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

  // Top up the pool in the background.
  triggerTopup(repo.source);

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
      repo: repoLabel(repo),
      source: repo.source,
      path: claimed.path,
      cold,
      warmedAt: claimed.warmedAt,
    },
    `${claimed.path}${warmedNote}\n(detached — create a branch with: git switch -c <name>)`,
  );
}

/**
 * Ensure a repo at `source` is configured. With a TTY (and not --json/--yes),
 * runs the interactive config flow; otherwise auto-registers with defaults so
 * agents have zero friction.
 */
async function ensureConfigured(source: string, opts: CmdOpts): Promise<void> {
  // Verify it's actually a git repo before offering setup.
  const isGit = run("git", ["-C", source, "rev-parse", "--git-dir"]);
  if (isGit.code !== 0) {
    throw new Error(`not a git repo: ${source}`);
  }
  if (isInteractive() && !opts.json && !opts.yes) {
    process.stderr.write(
      `"${tildify(source)}" isn't configured yet — let's set it up.\n`,
    );
    await configureRepoInteractive(source);
  } else {
    const sug = suggestSetup(source);
    writeRepoConfig({
      source,
      baseBranch: DEFAULT_BASE,
      setup: opts.skipSetup ? null : (sug.setup ?? undefined),
      minWarmPool: DEFAULT_MIN_WARM,
      maxWarmPool: DEFAULT_MAX_WARM,
      maxTotalPool: DEFAULT_MAX_TOTAL,
    });
    if (!opts.json && !opts.pathOnly) {
      process.stderr.write(
        `registered "${tildify(source)}"${sug.setup ? ` (setup: ${sug.setup})` : ""}.\n`,
      );
    }
  }
}

// ---- down ----

export async function cmdDown(
  idOrNothing: string | undefined,
  opts: CmdOpts,
): Promise<void> {
  // 1. Locate the worktree WITHOUT mutating state yet, so a safety abort below
  //    leaves it exactly as it was.
  const found = await withState((state): Worktree | null => {
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
    return { ...wt };
  });

  if (!found) return;

  // 2. Recycling resets the worktree to base, destroying anything not saved.
  //    Read the live HEAD and refuse if there's unsaved work (unless --force).
  const head = headInfo(found.path);
  if (!opts.force && hasUnsavedWork(head)) {
    const what = workLabel(head);
    const where = head.branch ? ` on branch "${head.branch}"` : "";
    throw new Error(
      `refusing to release ${found.id}: it has ${what} work${where}.\n` +
        `Recycling resets the worktree to its base branch and would discard it.\n` +
        `Commit and push (or stash) first, then retry — or pass --force to release anyway.`,
    );
  }

  // 3. Safe to release: flip to needs-resetup and clear ownership.
  const target = await withState((state): Worktree | null => {
    const wt = findById(state, found.id);
    if (!wt) return null;
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

  // Top up the originating repo's pool (resolve slug -> source).
  const config = loadConfig();
  const source = sourceForSlug(config, target.repo);
  if (source) triggerTopup(source);

  const note = head.branch
    ? ` (was on "${head.branch}"${opts.force && hasUnsavedWork(head) ? ", forced" : ""})`
    : "";
  out(
    opts.json,
    {
      id: target.id,
      repo: target.repo,
      released: true,
      wasBranch: head.branch,
      forced: Boolean(opts.force && hasUnsavedWork(head)),
    },
    `released ${target.id}${note} — returning to pool`,
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
      return "setting up";
    case "resetting":
      return "setting up";
    case "destroying":
      return "removing";
    default:
      return status;
  }
}

/**
 * Branch column, derived from the worktree's *live* HEAD (read off disk), not
 * the possibly-stale `branch` in state. If a branch is checked out, show it.
 * Otherwise HEAD is detached; show e.g. "main~ (a1b2c3d)" to convey "detached,
 * based on <base>, at this commit".
 */
function branchLabel(head: HeadInfo, baseBranch: string): string {
  if (head.branch) return head.branch;
  const commit = head.commit ? ` (${head.commit})` : "";
  return `${baseBranch}~${commit}`;
}

/**
 * Work column: a quick read of whether the worktree has anything worth saving
 * before it's recycled. Combines uncommitted changes and unpushed commits so a
 * `wt down` is never a surprise.
 */
function workLabel(head: HeadInfo): string {
  const parts: string[] = [];
  if (head.dirty) parts.push("uncommitted");
  if (head.branch) {
    if (!head.hasUpstream) {
      // A branch with commits but no remote tracking = unpushed work.
      if (head.commit) parts.push("unpushed");
    } else if (head.ahead > 0) {
      parts.push(`unpushed:${head.ahead}`);
    }
  }
  return parts.length ? parts.join("+") : "clean";
}

/**
 * Whether `wt list` needs to shell out to git for this worktree's live HEAD.
 *
 * Only worktrees a user could have touched can diverge from what state.json
 * already knows. `attached` ones were handed out (branch/commit/dirty may have
 * changed) and `needs-resetup` ones were released but not yet recycled (could
 * still briefly hold unpushed work). Everything else — `ready` (freshly built
 * or reset from base, detached, `git clean`'d, never handed out), plus the
 * transient `building`/`resetting`/`destroying` states — has a known HEAD we
 * can render straight from state, skipping a full-tree `git status` entirely.
 */
function needsLiveHead(w: Worktree): boolean {
  return w.status === "attached" || w.status === "needs-resetup";
}

/**
 * Synthesize a HeadInfo from stored state for worktrees we don't read live.
 * Such worktrees are detached at their base commit and clean by construction,
 * so this mirrors what a live `git status` would report without the cost.
 */
function headFromState(w: Worktree): HeadInfo {
  return {
    ...EMPTY_HEAD,
    commit: w.baseCommit ? w.baseCommit.slice(0, 11) : null,
  };
}

/** True when a worktree holds work that recycling would blow away. */
export function hasUnsavedWork(head: HeadInfo): boolean {
  if (head.dirty) return true;
  // Commits on a branch that aren't on a remote = unpushed work.
  if (head.branch && (!head.hasUpstream || head.ahead > 0)) {
    return head.commit != null;
  }
  return false;
}

export async function cmdList(
  token: string | undefined,
  opts: CmdOpts,
): Promise<void> {
  const config = loadConfig();
  const state = readState();

  // slug -> repo config, for base-branch + display lookups.
  const bySlug = new Map(
    Object.values(config.repos).map((r) => [repoSlug(r.source), r]),
  );
  const display = (slug: string): string => {
    const r = bySlug.get(slug);
    return r ? repoLabel(r) : slug;
  };

  // Include everything, even in-flight builds (pending placeholders).
  let wts = [...state.worktrees];
  if (token) {
    const filterSlug = resolveRepo(config, token).slug;
    wts = wts.filter((w) => w.repo === filterSlug);
  }

  // Sort: group by repo (display label), then ready first, then by age.
  const order = ["ready", "attached", "needs-resetup", "resetting", "building", "destroying"];
  wts.sort((a, b) => {
    const da = display(a.repo);
    const db = display(b.repo);
    if (da !== db) return da.localeCompare(db);
    const oa = order.indexOf(a.status);
    const ob = order.indexOf(b.status);
    if (oa !== ob) return oa - ob;
    return (b.warmedAt ?? 0) - (a.warmedAt ?? 0);
  });

  // Resolve each worktree's HEAD. For worktrees a user could have touched
  // (attached / needs-resetup) we read the *actual* branch / commit off disk,
  // since the user may have created a branch after we handed it out. Everything
  // else has a known HEAD (detached on base, clean) we render straight from
  // state — no `git status`, which is the expensive part of `wt list`.
  const heads = new Map<string, HeadInfo>();
  for (const w of wts) {
    if (!needsLiveHead(w)) heads.set(w.id, headFromState(w));
    else heads.set(w.id, headInfo(w.path));
  }
  const headFor = (w: Worktree): HeadInfo =>
    heads.get(w.id) ?? { ...EMPTY_HEAD };

  if (opts.json) {
    // Surface the live HEAD alongside the stored state so JSON consumers see
    // the truth too. `liveBranch` is the checked-out branch (or null/detached).
    const enriched = wts.map((w) => {
      const h = headFor(w);
      return {
        ...w,
        liveBranch: h.branch,
        liveCommit: h.commit,
        dirty: h.dirty,
        hasUpstream: h.hasUpstream,
        ahead: h.ahead,
        behind: h.behind,
        unsavedWork: hasUnsavedWork(h),
      };
    });
    out(true, enriched, "");
    return;
  }
  if (wts.length === 0) {
    process.stdout.write("no worktrees — run `wt up <repo>` to get one\n");
    return;
  }
  const rows = wts.map((w) => [
    w.id.startsWith("pending-") ? "—" : w.id,
    display(w.repo),
    statusLabel(w.status),
    branchLabel(headFor(w), bySlug.get(w.repo)?.baseBranch ?? "main"),
    workLabel(headFor(w)),
    w.warmedAt ? humanAge(w.warmedAt) : "—",
    w.path ? tildify(w.path) : "(building)",
  ]);
  printTable(["ID", "REPO", "STATUS", "BRANCH", "WORK", "AGE", "PATH"], rows);
}

// ---- prewarm ----

export async function cmdPrewarm(
  token: string,
  opts: CmdOpts,
): Promise<void> {
  const config = loadConfig();
  const resolved = resolveRepo(config, token);
  if (!resolved.cfg) {
    throw new Error(
      `"${token}" isn't configured. Run \`wt up ${token}\` or \`wt config ${token}\` first.`,
    );
  }
  const label = repoLabel(resolved.cfg);
  // Run top-up in the foreground so the user sees progress/errors.
  if (!opts.json) {
    process.stdout.write(`warming pool for "${label}"...\n`);
  }
  await topupRepo(resolved.source);
  const state = readState();
  const ready = worktreesForRepo(state, resolved.slug).filter(
    (w) => w.status === "ready",
  ).length;
  out(opts.json, { repo: label, ready }, `pool ready: ${ready} worktree(s)`);
}

// ---- config ----

export async function cmdConfig(opts: CmdOpts): Promise<void> {
  const config = loadConfig();
  const repos = Object.values(config.repos);

  if (opts.json) {
    const validations = repos.map((repo) => ({
      ...validateRepo(repo),
      name: repo.name,
    }));
    out(true, { configPath: configPath(), config, validations }, "");
    return;
  }

  // Header: where config + worktrees live.
  process.stdout.write("\n");
  process.stdout.write(`  config    ${tildify(configPath())}\n`);
  process.stdout.write(`  worktrees ${tildify(config.worktreeRoot)}\n\n`);

  if (repos.length === 0) {
    process.stdout.write("  no repos configured — run `wt up <path>` or `wt config <path>`\n\n");
    return;
  }
  const broken: { label: string; problems: string[] }[] = [];
  const rows = repos.map((repo) => {
    const v = validateRepo(repo);
    if (!v.ok) broken.push({ label: repoLabel(repo), problems: v.problems });
    return [
      v.ok ? "✓" : "✗",
      repoLabel(repo),
      repo.baseBranch,
      poolLabel(repo),
      repo.setup ?? "—",
      tildify(repo.source),
    ];
  });
  printTable(["", "REPO", "BASE", "WARM/TOTAL", "SETUP", "SOURCE"], rows, "  ");

  if (broken.length) {
    process.stdout.write("\n  problems:\n");
    for (const b of broken) {
      for (const p of b.problems) {
        process.stdout.write(`    ✗ ${b.label}: ${p}\n`);
      }
    }
  }
  process.stdout.write("\n");
}

// ---- config <repo> (add / edit a repo) ----

export async function cmdConfigRepo(
  token: string,
  opts: CmdOpts,
): Promise<void> {
  const config = loadConfig();

  // Resolve the token to a source path. A path-like token is the source; an
  // alias resolves to an existing repo's source; --source overrides.
  let source: string;
  if (opts.source) source = opts.source;
  else if (looksLikePath(token)) source = token;
  else {
    // alias: must already exist (you can't name a repo that has no path)
    const r = config.repos[token] ?? findByAlias(config, token);
    if (!r) {
      throw new Error(
        `"${token}" isn't a path or a known alias. Pass a path, e.g. wt config ~/code/${token}.`,
      );
    }
    source = r.source;
  }

  const existing = resolveRepo(config, source).cfg;

  const hasSetters =
    opts.source !== undefined ||
    opts.baseBranch !== undefined ||
    opts.setup !== undefined ||
    opts.noSetup ||
    opts.minWarmPool !== undefined ||
    opts.maxWarmPool !== undefined ||
    opts.maxTotalPool !== undefined ||
    opts.name !== undefined;

  const interactive = isInteractive() && !opts.json && !opts.yes && !hasSetters;

  if (!interactive) {
    // ---- flag / agent mode ----
    const sug = suggestSetup(expandPath(source));
    const setup = opts.noSetup
      ? null
      : opts.setup !== undefined
        ? opts.setup
        : existing?.setup !== undefined
          ? existing.setup
          : (sug.setup ?? undefined);
    writeRepoConfig({
      source,
      name: opts.name ?? existing?.name,
      baseBranch: opts.baseBranch ?? existing?.baseBranch ?? DEFAULT_BASE,
      setup: setup as string | null | undefined,
      minWarmPool: opts.minWarmPool ?? existing?.minWarmPool ?? DEFAULT_MIN_WARM,
      maxWarmPool: opts.maxWarmPool ?? existing?.maxWarmPool ?? DEFAULT_MAX_WARM,
      maxTotalPool:
        opts.maxTotalPool ?? existing?.maxTotalPool ?? DEFAULT_MAX_TOTAL,
    });
    finishConfigRepo(source, opts);
    return;
  }

  // ---- interactive mode ----
  await configureRepoInteractive(source, existing ?? undefined);
  finishConfigRepo(source, opts);
}

function findByAlias(
  config: Config,
  alias: string,
): RepoConfig | null {
  try {
    return resolveRepo(config, alias).cfg;
  } catch {
    return null;
  }
}

/** Prompt for repo settings and write the config. Used by `config <repo>` and
 *  the auto-offer in `up`. */
async function configureRepoInteractive(
  source: string,
  existing?: RepoConfig,
): Promise<void> {
  process.stdout.write(
    `\nConfiguring "${tildify(source)}" — press enter to accept defaults.\n\n`,
  );
  const baseBranch = await prompt(
    "base branch",
    existing?.baseBranch ?? DEFAULT_BASE,
  );

  const sug = suggestSetup(expandPath(source));
  if (sug.setup && !existing?.setup) {
    process.stdout.write(
      `  (detected ${sug.reason} → suggesting "${sug.setup}")\n`,
    );
  }
  const setupAns = await prompt(
    "setup command (blank for none)",
    existing?.setup ?? sug.setup ?? "",
  );
  const minWarmAns = await prompt(
    "min warm pool (always keep this many ready)",
    String(existing?.minWarmPool ?? DEFAULT_MIN_WARM),
  );
  const maxWarmAns = await prompt(
    "max warm pool (pre-build up to this many)",
    String(existing?.maxWarmPool ?? DEFAULT_MAX_WARM),
  );
  const maxTotalAns = await prompt(
    "max total pool (hard cap on worktrees)",
    String(existing?.maxTotalPool ?? DEFAULT_MAX_TOTAL),
  );
  const nameAns = await prompt(
    "alias name (optional)",
    existing?.name ?? "",
  );

  writeRepoConfig({
    source,
    name: nameAns === "" ? null : nameAns,
    baseBranch,
    setup: setupAns === "" ? null : setupAns,
    minWarmPool: parseIntOr(minWarmAns, DEFAULT_MIN_WARM),
    maxWarmPool: parseIntOr(maxWarmAns, DEFAULT_MAX_WARM),
    maxTotalPool: parseIntOr(maxTotalAns, DEFAULT_MAX_TOTAL),
  });
}

function parseIntOr(s: string, fallback: number): number {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Re-load, validate the just-written repo, and report the result. */
function finishConfigRepo(source: string, opts: CmdOpts): void {
  const config = loadConfig();
  const repo = resolveRepo(config, source).cfg;
  if (!repo) return;
  const v = validateRepo(repo);
  const label = repoLabel(repo);

  if (opts.json) {
    out(true, { repo: label, config: repo, validation: v }, "");
    return;
  }
  process.stdout.write("\n");
  process.stdout.write(`  saved "${label}" to ${tildify(configPath())}\n\n`);
  printTable(
    ["", "REPO", "BASE", "WARM/TOTAL", "SETUP", "SOURCE"],
    [
      [
        v.ok ? "✓" : "✗",
        label,
        repo.baseBranch,
        poolLabel(repo),
        repo.setup ?? "—",
        tildify(repo.source),
      ],
    ],
    "  ",
  );
  if (!v.ok) {
    process.stdout.write("\n  problems:\n");
    for (const p of v.problems) process.stdout.write(`    ✗ ${p}\n`);
  } else {
    process.stdout.write(`\n  try it: wt up ${label}\n`);
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
