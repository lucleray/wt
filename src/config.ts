import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { expandPath, parseJsonc, run } from "./util.js";

export interface RepoConfig {
  source: string;
  baseBranch: string;
  setup?: string;
  /** Warm floor: always keep at least this many `ready` worktrees. */
  minPool: number;
  /** Total ceiling: destroy released worktrees only when total exceeds this. */
  maxPool: number;
}

export interface Config {
  worktreeRoot: string;
  repos: Record<string, RepoConfig>;
}

interface RawRepoConfig {
  source?: string;
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
  for (const [name, r] of Object.entries(raw.repos ?? {})) {
    if (!r.source) {
      throw new Error(`repo "${name}" is missing required field "source"`);
    }
    // poolSize is a back-compat alias that sets both bounds.
    const min = r.minPool ?? r.poolSize ?? 1;
    let max = r.maxPool ?? r.poolSize ?? min;
    if (max < min) max = min; // max can never be below min
    repos[name] = {
      source: expandPath(r.source),
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
  source: string;
  baseBranch?: string;
  setup?: string | null;
  minPool?: number;
  maxPool?: number;
}

/**
 * Create or update a single repo entry and write the config back to disk as
 * formatted JSON (comments in an existing file are not preserved). Paths are
 * stored as given (so a `~/...` source stays `~/...`).
 */
export function writeRepoConfig(name: string, input: RepoConfigInput): void {
  const raw = readRawConfig();
  raw.repos ??= {};
  const existing = raw.repos[name] ?? {};
  const next: RawRepoConfig = { ...existing, source: input.source };
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
  raw.repos[name] = next;

  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
}

export function getRepo(config: Config, name: string): RepoConfig {
  const repo = config.repos[name];
  if (!repo) {
    const known = Object.keys(config.repos).join(", ") || "(none)";
    throw new Error(`unknown repo "${name}". Configured repos: ${known}`);
  }
  return repo;
}

export interface RepoValidation {
  name: string;
  source: string;
  baseBranch: string;
  ok: boolean;
  problems: string[];
}

export function validateRepo(name: string, repo: RepoConfig): RepoValidation {
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
    name,
    source: repo.source,
    baseBranch: repo.baseBranch,
    ok: problems.length === 0,
    problems,
  };
}
