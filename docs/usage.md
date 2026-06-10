# Usage

All commands accept `--json` for machine-readable output, which is what agents
should use.

A `<repo>` is a **path** (e.g. `~/w/vercel/api`) or a configured **alias**
(e.g. `api`). Paths are first-class; aliases are an optional convenience.

## `wt up <repo>`

Get a ready worktree for `<repo>` and print its absolute path. The worktree is
detached at the base branch — create your own branch once you're in it
(`git switch -c <name>`).

```sh
wt up ~/w/vercel/api               # by path; sets it up on first use
wt up api                          # by alias (once configured)
wt up ~/w/vercel/api --path-only   # print only the path (for cd "$(...)")
wt up ~/w/vercel/api --skip-setup  # cold build without running the setup script
wt up ~/w/vercel/api --json

# typical: get a worktree, cd in, branch
cd "$(wt up ~/w/vercel/api --path-only)" && git switch -c luc/feature
```

Behavior:

- The first time you `up` an **unconfigured path**, `wt` sets it up: in a
  terminal it prompts; for agents (no TTY) it auto-registers with a detected
  setup command and defaults, then continues.
- If a `ready` worktree exists, it is handed out instantly.
- If none is ready, one is built on demand (slower; a warning is printed).
- After handing out, a background top-up refills the pool.
- Prints how long ago the worktree was warmed so you can refresh if needed.

`--skip-setup` only affects a **cold build** (when the pool is empty): the
worktree is checked out but the repo's setup script (e.g. `pnpm install`) is
not run. Useful on a bad connection where `pnpm install` can't succeed — you
get a usable checkout immediately and can run setup yourself later. If a warm
worktree is already available, the flag has no effect (it was set up at warm
time). Releasing a skipped worktree with `wt down` lets the background top-up
run setup and heal it back to a fully-ready state.

## `wt down [<id>]`

Release a worktree back to the pool. With no argument, releases the worktree
that contains the current working directory.

```sh
wt down              # release the worktree you're in
wt down ab12         # release by id
```

`down` is instant: it detaches HEAD and marks the worktree for re-setup, which
happens during the next background top-up. Your `node_modules` is preserved for
reuse. If the pool is over capacity, the worktree is destroyed instead.

## `wt list [<repo>]` (alias: `wt ls`)

List all worktrees and their status, optionally filtered to one repo. Includes
in-flight builds (shown as `setting up`). Status values:

- `ready` — warm, set up, available to hand out
- `in use` — attached to a session
- `recycling` — released, waiting to be reset + re-set-up
- `setting up` — being checked out / set up right now
- `removing` — being torn down

```sh
wt list
wt list front
wt ls
wt list --json
```

Pool bounds (`minPool` / `maxPool`) are shown by `wt config`.

## `wt prewarm <repo>`

Warm the pool until it reaches the repo's `minPool` ready worktrees. Runs in
the foreground so you see progress and any setup errors.

```sh
wt prewarm front
```

## `wt gc`

Prune worktrees that have been removed on disk or are otherwise stale, and run
`git worktree prune` on each source repo.

```sh
wt gc
```

## `wt config`

Print and validate the resolved configuration.

```sh
wt config
wt config --json
```

## Typical agent flow

```sh
# agent is started in ~/w with no repo
path="$(wt up ~/w/vercel/api --path-only)"
cd "$path"
git switch -c luc/my-feature
# ...make changes, commit, push, open PR...
wt down
```
