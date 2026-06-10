import { existsSync } from "node:fs";
import { join } from "node:path";

export interface Suggestion {
  /** The suggested setup command, or null if nothing was detected. */
  setup: string | null;
  /** Why this was suggested (the file that triggered it), for display. */
  reason: string | null;
}

/**
 * Suggest a setup command for a repo by inspecting marker files in its root.
 * Order matters: more specific / lockfile-based managers win over generic ones.
 */
export function suggestSetup(repoPath: string): Suggestion {
  const has = (f: string) => existsSync(join(repoPath, f));

  // JavaScript / TypeScript package managers (lockfile decides the manager).
  if (has("pnpm-lock.yaml") || has("pnpm-workspace.yaml")) {
    return { setup: "pnpm install", reason: "pnpm-lock.yaml" };
  }
  if (has("yarn.lock")) {
    return { setup: "yarn install", reason: "yarn.lock" };
  }
  if (has("bun.lockb") || has("bun.lock")) {
    return { setup: "bun install", reason: "bun.lock" };
  }
  if (has("package-lock.json")) {
    return { setup: "npm install", reason: "package-lock.json" };
  }
  if (has("package.json")) {
    return { setup: "npm install", reason: "package.json" };
  }

  // Other ecosystems.
  if (has("Cargo.toml")) {
    return { setup: "cargo fetch", reason: "Cargo.toml" };
  }
  if (has("go.mod")) {
    return { setup: "go mod download", reason: "go.mod" };
  }
  if (has("requirements.txt")) {
    return { setup: "pip install -r requirements.txt", reason: "requirements.txt" };
  }
  if (has("poetry.lock") || has("pyproject.toml")) {
    return { setup: "poetry install", reason: "pyproject.toml" };
  }
  if (has("Gemfile")) {
    return { setup: "bundle install", reason: "Gemfile" };
  }

  return { setup: null, reason: null };
}
