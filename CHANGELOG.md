# @lucleray/wt

## 0.7.0

### Minor Changes

- 1caa96b: Suggested setup commands no longer rewrite the lockfile (`pnpm install --frozen-lockfile`, `yarn install --immutable` / `--frozen-lockfile`, `bun install --frozen-lockfile`, `npm ci`), so warm worktrees stay clean. `wt up` now warns when a setup command modifies tracked files.
