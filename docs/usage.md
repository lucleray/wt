# Usage

All commands accept `--json` for machine-readable output, which is what agents
should use.

## `wt up <repo> [branch]`

Get a ready worktree for `<repo>` and print its absolute path. If `branch` is
given, a new branch is created and checked out in the worktree; otherwise the
worktree stays detached at the base branch.

```sh
wt up front                  # detached at main, prints path
wt up front luc/my-feature   # creates + checks out luc/my-feature
wt up front --path-only      # print only the path (for cd "$(...)")
wt up front --json
```

Behavior:

- If a `ready` worktree exists, it is handed out instantly.
- If none is ready, one is built on demand (slower; a warning is printed).
- After handing out, a background top-up refills the pool.
- Prints how long ago the worktree was warmed so you can refresh if needed.

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

## `wt list [<repo>]`

List worktrees and their status.

```sh
wt list
wt list front
wt list --json
```

## `wt status`

Show pool health per repo: ready / attached / needs-resetup / target counts.

```sh
wt status
wt status --json
```

## `wt prewarm <repo> [-n N]`

Build N ready worktrees in the background (default: enough to reach `poolSize`).

```sh
wt prewarm front
wt prewarm front -n 3
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
path="$(wt up front --path-only)"
cd "$path"
git switch -c luc/my-feature
# ...make changes, commit, push, open PR...
wt down
```
