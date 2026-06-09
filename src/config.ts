import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandPath, parseJsonc, run } from "./util.js";

export interface RepoConfig {
  source: string;
  baseBranch: string;
  setup?: string;
  poolSize: number;
}

export interface Config {
  worktreeRoot: string;
  repos: Record<string, RepoConfig>;
}

interface RawRepoConfig {
  source?: string;
  baseBranch?: string;
  setup?: string;
  poolSize?: number;
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
    repos[name] = {
      source: expandPath(r.source),
      baseBranch: r.baseBranch ?? "main",
      setup: r.setup,
      poolSize: r.poolSize ?? 1,
    };
  }
  return { worktreeRoot, repos };
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
