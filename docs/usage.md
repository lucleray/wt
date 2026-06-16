# Usage

All commands accept `--json` for machine-readable output, which is what agents
should use.

A `<repo>` is a **path** (e.g. `~/code/acme-app`) or a configured **alias**
(e.g. `app`). Paths are first-class; aliases are an optional convenience.

## `wt up <repo>`

Get a ready worktree for `<repo>` and print its absolute path. The worktree is
detached at the base branch — create your own branch once you're in it
(`git switch -c <name>`).

```sh
wt up ~/code/acme-app               # by path; sets it up on first use
wt up app                           # by alias (once configured)
wt up ~/code/acme-app --path-only   # print only the path (for cd "$(...)")
wt up ~/code/acme-app --skip-setup  # cold build without running the setup script
wt up ~/code/acme-app --json
wt up ~/code/acme-app --meta '{"sessionId":"abc123"}'  # tag with caller metadata

# typical: get a worktree, cd in, branch
cd "$(wt up ~/code/acme-app --path-only)" && git switch -c feature/login
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

`--meta <json>` attaches a JSON object of caller metadata to the worktree. It's
stored on the worktree record and surfaced in `wt list --json` as `sessionMeta`,
alongside an auto-captured `sessionInfo` (the attaching process's pid, process
name, command, and cwd). Agents use this to tag a worktree with e.g. their
session id, then find it again later:

```sh
wt up ~/code/acme-app --path-only --meta '{"sessionId":"abc123","task":"luc/feature"}'
# later:
wt list --json | jq '.[] | select(.sessionMeta.sessionId == "abc123")'
```

Both `sessionInfo` and `sessionMeta` are informational only (never used to
reclaim a worktree) and are cleared on `wt down`. The value must be a JSON
object — a malformed `--meta` makes `wt up` fail before handing out a worktree.

## `wt down [<id>]`

Release a worktree back to the pool. With no argument, releases the worktree
that contains the current working directory.

```sh
wt down              # release the worktree you're in
wt down ab12         # release by id
wt down ab12 --force # release even if it has unsaved work
```

`down` is instant: it detaches HEAD and marks the worktree for re-setup, which
happens during the next background top-up. Your `node_modules` is preserved for
reuse. If the warm pool is already full (`maxWarmPool`) or the pool is over its
total cap (`maxTotalPool`), the worktree is destroyed instead.

**Safety:** recycling resets the worktree to its base branch, so `down` refuses
if the worktree has **unsaved work** — uncommitted changes, or commits on a
branch that aren't pushed to a remote. Commit + push (or stash) first, or pass
`--force` to release anyway. (The branch ref itself survives in the source repo
even after a forced release, so committed work is still recoverable.)

## `wt list [<repo>]` (alias: `wt ls`)

List all worktrees and their status, optionally filtered to one repo. Includes
in-flight builds (shown as `setting up`). Status values:

- `ready` — warm, set up, available to hand out
- `in use` — attached to a session
- `recycling` — released, waiting to be reset + re-set-up
- `setting up` — being checked out / set up right now
- `removing` — being torn down

The **BRANCH** column shows the live checked-out branch (or `<base>~ (commit)`
when detached), read straight from the worktree via cheap git plumbing — listing
does **not** run `git status` (that scan is what `wt down` uses to guard against
discarding unsaved work). `--json` adds `liveBranch`, `liveCommit`, `ahead`,
`behind`, and the attach metadata `sessionInfo` / `sessionMeta` (see `wt up
--meta`).

```sh
wt list
wt list app
wt ls
wt list --json
```

Pool bounds (`minWarmPool` / `maxWarmPool` / `maxTotalPool`) are shown by
`wt config` in the `WARM/TOTAL` column (e.g. `1–5/25`).

## `wt prewarm <repo>`

Warm the pool until it reaches the repo's `maxWarmPool` ready worktrees. Runs in
the foreground so you see progress and any setup errors.

```sh
wt prewarm app
```

## `wt config`

Print and validate the resolved configuration.

```sh
wt config
wt config --json
```

## Typical agent flow

```sh
# agent is started in ~ with no repo
path="$(wt up ~/code/acme-app --path-only)"
cd "$path"
git switch -c feature/my-feature
# ...make changes, commit, push, open PR...
wt down
```
