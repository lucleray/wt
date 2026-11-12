# @lucleray/wt

## 0.8.1

### Patch Changes

- 53e5fe2: The skill and usage docs no longer store the worktree path in a shell variable named `path`: in zsh that variable is tied to `PATH`, so every command after it failed with "command not found".

## 0.8.0

### Minor Changes

- 596eb71: `wt down` and `wt cleanup` now refuse to release a worktree with commits on a detached HEAD that no branch, remote ref, or tag contains. `wt down --force` pins those commits under `refs/wt/rescue/<id>-<timestamp>` before recycling. The check is skipped when HEAD still equals the warmed base commit, so the common case stays free and `wt list` is unaffected.

## 0.7.0

### Minor Changes

- 1caa96b: Suggested setup commands no longer rewrite the lockfile (`pnpm install --frozen-lockfile`, `yarn install --immutable` / `--frozen-lockfile`, `bun install --frozen-lockfile`, `npm ci`), so warm worktrees stay clean. `wt up` now warns when a setup command modifies tracked files.
