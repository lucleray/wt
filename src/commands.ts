import {
  loadConfig,
  validateRepo,
  configPath,
  writeRepoConfig,
  repoLabel,
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
  type HeadInfo,
} from "./worktree.js";
import { topupRepo } from "./topup.js";
import { reconcile } from "./reconcile.js";
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
  // `wt config <repo>` setters (non-interactive / agent mode):
  source?: string;
  name?: string;
  baseBranch?: string;
  setup?: string;
  noSetup?: boolean;
  minPool?: number;
  maxPool?: number;
  yes?: boolean;
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

  // Clean up any crashed/stale worktrees before handing one out.
  await reconcile(config);

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
      minPool: DEFAULT_MIN,
      maxPool: DEFAULT_MAX,
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

  // Top up the originating repo's pool (resolve slug -> source).
  const config = loadConfig();
  const source = sourceForSlug(config, target.repo);
  if (source) triggerTopup(source);

  out(
    opts.json,
    { id: target.id, repo: target.repo, released: true },
    `released ${target.id} — returning to pool`,
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

  // Read each worktree's live HEAD off disk so we report the *actual* branch /
  // commit, not the stale `branch` in state (the user may have created a branch
  // after we handed the worktree out).
  const heads = new Map<string, HeadInfo>();
  for (const w of wts) heads.set(w.id, headInfo(w.path));
  const headFor = (w: Worktree): HeadInfo =>
    heads.get(w.id) ?? { branch: null, commit: null };

  if (opts.json) {
    // Surface the live HEAD alongside the stored state so JSON consumers see
    // the truth too. `liveBranch` is the checked-out branch (or null/detached).
    const enriched = wts.map((w) => {
      const h = headFor(w);
      return { ...w, liveBranch: h.branch, liveCommit: h.commit };
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
    w.warmedAt ? humanAge(w.warmedAt) : "—",
    w.path ? tildify(w.path) : "(building)",
  ]);
  printTable(["ID", "REPO", "STATUS", "BRANCH", "AGE", "PATH"], rows);
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
      `${repo.minPool}–${repo.maxPool}`,
      repo.setup ?? "—",
      tildify(repo.source),
    ];
  });
  printTable(["", "REPO", "BASE", "POOL", "SETUP", "SOURCE"], rows, "  ");

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

const DEFAULT_MIN = 1;
const DEFAULT_MAX = 5;
const DEFAULT_BASE = "main";

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
    opts.minPool !== undefined ||
    opts.maxPool !== undefined ||
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
      minPool: opts.minPool ?? existing?.minPool ?? DEFAULT_MIN,
      maxPool: opts.maxPool ?? existing?.maxPool ?? DEFAULT_MAX,
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
  const minAns = await prompt("min pool", String(existing?.minPool ?? DEFAULT_MIN));
  const maxAns = await prompt("max pool", String(existing?.maxPool ?? DEFAULT_MAX));
  const nameAns = await prompt(
    "alias name (optional)",
    existing?.name ?? "",
  );

  writeRepoConfig({
    source,
    name: nameAns === "" ? null : nameAns,
    baseBranch,
    setup: setupAns === "" ? null : setupAns,
    minPool: parseIntOr(minAns, DEFAULT_MIN),
    maxPool: parseIntOr(maxAns, DEFAULT_MAX),
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
    ["", "REPO", "BASE", "POOL", "SETUP", "SOURCE"],
    [
      [
        v.ok ? "✓" : "✗",
        label,
        repo.baseBranch,
        `${repo.minPool}–${repo.maxPool}`,
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
