---
"@lucleray/wt": minor
---

Suggested setup commands no longer rewrite the lockfile (`pnpm install --frozen-lockfile`, `yarn install --immutable` / `--frozen-lockfile`, `bun install --frozen-lockfile`, `npm ci`), so warm worktrees stay clean. `wt up` now warns when a setup command modifies tracked files.
