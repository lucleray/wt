import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { expandPath, parseJsonc, run } from "./util.js";

export interface RepoConfig {
  /** Absolute path to the source repo — the primary identity. */
  source: string;
  /** Optional friendly alias (nice-to-have on top of the path). */
  name?: string;
  baseBranch: string;
  setup?: string;
  /** Warm floor: always keep at least this many `ready` worktrees. */
  minWarmPool: number;
  /** Warm ceiling: pre-build up to this many `ready` worktrees (never more). */
  maxWarmPool: number;
  /** Total ceiling: refuse to grow the pool beyond this many worktrees on disk. */
  maxTotalPool: number;
}

export interface Config {
  worktreeRoot: string;
  /** Keyed by source path (as written in the file, e.g. "~/code/acme-app"). */
  repos: Record<string, RepoConfig>;
}

interface RawRepoConfig {
  /** Legacy: old configs keyed repos by name and stored source here. */
  source?: string;
  name?: string;
  baseBranch?: string;
  setup?: string;
  /** Current pool knobs. */
  minWarmPool?: number;
  maxWarmPool?: number;
  maxTotalPool?: number;
  /** Legacy alias: minPool -> minWarmPool. */
  minPool?: number;
  /** Legacy alias: maxPool -> maxTotalPool. */
  maxPool?: number;
  /** Legacy alias: poolSize -> sets warm + total bounds to a fixed size. */
  poolSize?: number;
}

interface RawConfig {
  worktreeRoot?: string;
  repos?: Record<string, RawRepoConfig>;
}

/** Pool sizing defaults: keep 1 warm minimum, pre-warm up to 5, allow 25 total. */
export const DEFAULT_MIN_WARM = 1;
export const DEFAULT_MAX_WARM = 5;
export const DEFAULT_MAX_TOTAL = 25;
export const DEFAULT_BASE = "main";

export function configDir(): string {
  if (process.env.WT_CONFIG_DIR) return expandPath(process.env.WT_CONFIG_DIR);
  return join(homedir(), ".wt");
}

export function configPath(): string {
  if (process.env.WT_CONFIG) return expandPath(process.env.WT_CONFIG);
  return join(configDir(), "config.jsonc");
}

export function loadConfig(): Config {
  const path = configPath();
  // A missing config file is not an error: a fresh install simply has no repos
  // configured yet. Treat it as an empty config so `wt up <path>` can bootstrap
  // it (auto-register) and read-only commands like `list` / `config` behave
  // sanely instead of failing.
  if (!existsSync(path)) {
    return { worktreeRoot: expandPath(join(configDir(), "worktrees")), repos: {} };
  }
  const raw = parseJsonc<RawConfig>(readFileSync(path, "utf8"));
  const worktreeRoot = expandPath(
    raw.worktreeRoot ?? join(configDir(), "worktrees"),
  );
  const repos: Record<string, RepoConfig> = {};
  for (const [key, r] of Object.entries(raw.repos ?? {})) {
    // Path-primary: the key IS the source path. Legacy configs keyed by name
    // and stored the path in `source`; detect those and migrate in-memory.
    const isLegacy = Boolean(r.source);
    const sourceKey = isLegacy ? (r.source as string) : key;
    const name = isLegacy ? key : r.name;

    repos[expandPath(sourceKey)] = {
      source: expandPath(sourceKey),
      name,
      baseBranch: r.baseBranch ?? DEFAULT_BASE,
      setup: r.setup,
      ...resolvePoolBounds(r),
    };
  }
  return { worktreeRoot, repos };
}

interface PoolBounds {
  minWarmPool: number;
  maxWarmPool: number;
  maxTotalPool: number;
}

/**
 * Resolve the three pool knobs from a raw repo entry, honoring legacy aliases:
 *   minPool  -> minWarmPool   (warm floor)
 *   maxPool  -> maxTotalPool  (total ceiling)
 *   poolSize -> a fixed-size pool (sets all three)
 * New keys win over legacy ones. The result is clamped so that
 * minWarmPool <= maxWarmPool <= maxTotalPool always holds.
 */
export function resolvePoolBounds(r: RawRepoConfig): PoolBounds {
  let minWarm = r.minWarmPool ?? r.minPool ?? r.poolSize ?? DEFAULT_MIN_WARM;

  // Resolve the total cap first: explicit new key, else legacy maxPool/poolSize,
  // else the default total cap (at least as large as the warm floor).
  let maxTotal =
    r.maxTotalPool ?? r.maxPool ?? r.poolSize ?? Math.max(DEFAULT_MAX_TOTAL, minWarm);

  // maxWarm has no direct legacy key. poolSize pins it; otherwise default to the
  // warm cap but never above the (possibly legacy/smaller) total cap, so an old
  // `maxPool: 3` doesn't silently widen the warm pool to 5.
  let maxWarm =
    r.maxWarmPool ?? r.poolSize ?? Math.min(Math.max(DEFAULT_MAX_WARM, minWarm), maxTotal);

  // Clamp into a coherent ordering: minWarm <= maxWarm <= maxTotal.
  if (minWarm < 1) minWarm = 1;
  if (maxWarm < minWarm) maxWarm = minWarm;
  if (maxTotal < maxWarm) maxTotal = maxWarm;
  return { minWarmPool: minWarm, maxWarmPool: maxWarm, maxTotalPool: maxTotal };
}

/** Read the raw (unexpanded) config, or an empty one if the file is absent. */
export function readRawConfig(): RawConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  return parseJsonc<RawConfig>(readFileSync(path, "utf8"));
}

export interface RepoConfigInput {
  /** Source path — the config key (stored as given, e.g. "~/code/acme-app"). */
  source: string;
  name?: string | null;
  baseBranch?: string;
  setup?: string | null;
  minWarmPool?: number;
  maxWarmPool?: number;
  maxTotalPool?: number;
}

/**
 * Create or update a single repo entry, keyed by its source PATH. Migrates any
 * legacy name-keyed entry pointing at the same source. Writes the config back
 * as formatted JSON (comments are not preserved). The source path is stored as
 * given (so a `~/...` source stays `~/...`).
 */
export function writeRepoConfig(input: RepoConfigInput): void {
  const raw = readRawConfig();
  raw.repos ??= {};

  // Find any existing entry (path-keyed or legacy name-keyed) for this source.
  const target = expandPath(input.source);
  let existingKey: string | undefined;
  let existing: RawRepoConfig = {};
  for (const [key, r] of Object.entries(raw.repos)) {
    const entrySource = r.source ?? key; // legacy stored path in `source`
    if (expandPath(entrySource) === target) {
      existingKey = key;
      existing = r;
      break;
    }
  }

  const next: RawRepoConfig = { ...existing };
  // Path-keyed shape: the key is the source, so no `source` field on the value.
  delete next.source;

  if (input.name !== undefined) {
    if (input.name === null || input.name === "") delete next.name;
    else next.name = input.name;
  }
  if (input.baseBranch !== undefined) next.baseBranch = input.baseBranch;
  if (input.setup !== undefined) {
    if (input.setup === null || input.setup === "") delete next.setup;
    else next.setup = input.setup;
  }
  if (input.minWarmPool !== undefined) next.minWarmPool = input.minWarmPool;
  if (input.maxWarmPool !== undefined) next.maxWarmPool = input.maxWarmPool;
  if (input.maxTotalPool !== undefined) next.maxTotalPool = input.maxTotalPool;
  // Migrate away from the legacy pool aliases once any new bound is set.
  if (
    next.minWarmPool !== undefined ||
    next.maxWarmPool !== undefined ||
    next.maxTotalPool !== undefined
  ) {
    delete next.poolSize;
    delete next.minPool;
    delete next.maxPool;
  }

  // Remove the legacy key if it differed from the path key, then write under
  // the path key.
  if (existingKey && existingKey !== input.source) delete raw.repos[existingKey];
  raw.repos[input.source] = next;

  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
}

export interface RepoValidation {
  source: string;
  baseBranch: string;
  ok: boolean;
  problems: string[];
}

export function validateRepo(repo: RepoConfig): RepoValidation {
  const problems: string[] = [];
  if (!existsSync(repo.source)) {
    problems.push(`source does not exist: ${repo.source}`);
  } else {
    const isGit = run("git", ["-C", repo.source, "rev-parse", "--git-dir"]);
    if (isGit.code !== 0) {
      problems.push(`source is not a git repo: ${repo.source}`);
    } else {
      const branch = run("git", [
        "-C",
        repo.source,
        "rev-parse",
        "--verify",
        "--quiet",
        repo.baseBranch,
      ]);
      if (branch.code !== 0) {
        problems.push(`base branch not found: ${repo.baseBranch}`);
      }
    }
  }
  return {
    source: repo.source,
    baseBranch: repo.baseBranch,
    ok: problems.length === 0,
    problems,
  };
}

/** Display label for a repo: its alias name if set, else the basename. */
export function repoLabel(repo: { name?: string; source: string }): string {
  return repo.name ?? basename(repo.source);
}
