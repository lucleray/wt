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
  minPool: number;
  /** Total ceiling: destroy released worktrees only when total exceeds this. */
  maxPool: number;
}

export interface Config {
  worktreeRoot: string;
  /** Keyed by source path (as written in the file, e.g. "~/w/vercel/api"). */
  repos: Record<string, RepoConfig>;
}

interface RawRepoConfig {
  /** Legacy: old configs keyed repos by name and stored source here. */
  source?: string;
  name?: string;
  baseBranch?: string;
  setup?: string;
  /** Backwards-compatible alias: sets both minPool and maxPool. */
  poolSize?: number;
  minPool?: number;
  maxPool?: number;
}

interface RawConfig {
  worktreeRoot?: string;
  repos?: Record<string, RawRepoConfig>;
}

export function configDir(): string {
  if (process.env.WT_CONFIG_DIR) return expandPath(process.env.WT_CONFIG_DIR);
  return join(homedir(), ".config", "wt");
}

export function configPath(): string {
  if (process.env.WT_CONFIG) return expandPath(process.env.WT_CONFIG);
  return join(configDir(), "config.jsonc");
}

export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) {
    throw new Error(
      `no config found at ${path}\n` +
        `create one — see docs/config.md or run with WT_CONFIG set.`,
    );
  }
  const raw = parseJsonc<RawConfig>(readFileSync(path, "utf8"));
  const worktreeRoot = expandPath(
    raw.worktreeRoot ?? join(homedir(), "w", "worktrees"),
  );
  const repos: Record<string, RepoConfig> = {};
  for (const [key, r] of Object.entries(raw.repos ?? {})) {
    // Path-primary: the key IS the source path. Legacy configs keyed by name
    // and stored the path in `source`; detect those and migrate in-memory.
    const isLegacy = Boolean(r.source);
    const sourceKey = isLegacy ? (r.source as string) : key;
    const name = isLegacy ? key : r.name;

    // poolSize is a back-compat alias that sets both bounds.
    const min = r.minPool ?? r.poolSize ?? 1;
    let max = r.maxPool ?? r.poolSize ?? min;
    if (max < min) max = min; // max can never be below min
    repos[expandPath(sourceKey)] = {
      source: expandPath(sourceKey),
      name,
      baseBranch: r.baseBranch ?? "main",
      setup: r.setup,
      minPool: min,
      maxPool: max,
    };
  }
  return { worktreeRoot, repos };
}

/** Read the raw (unexpanded) config, or an empty one if the file is absent. */
export function readRawConfig(): RawConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  return parseJsonc<RawConfig>(readFileSync(path, "utf8"));
}

export interface RepoConfigInput {
  /** Source path — the config key (stored as given, e.g. "~/w/vercel/api"). */
  source: string;
  name?: string | null;
  baseBranch?: string;
  setup?: string | null;
  minPool?: number;
  maxPool?: number;
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
  if (input.minPool !== undefined) next.minPool = input.minPool;
  if (input.maxPool !== undefined) next.maxPool = input.maxPool;
  // Migrate away from the legacy poolSize alias once min/max are set.
  if (next.minPool !== undefined || next.maxPool !== undefined) {
    delete next.poolSize;
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
