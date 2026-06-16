---
name: wt
description: Spin up a ready-to-work git worktree for any repo instantly via the wt pool manager. Repos are addressed by path (e.g. wt up ~/code/acme-app) or an optional alias; unconfigured paths are set up automatically. Use when starting work on a repo and you're not already inside its checkout, or when releasing a worktree once work is done.
license: MIT
---

# wt — git worktree pool manager

`wt` keeps a warm pool of pre-installed git worktrees per repo so you can get a
ready-to-work environment **instantly** (no waiting on checkout + install).

Install: `npm install -g @lucleray/wt`. Source & docs:
<https://github.com/lucleray/wt> (README + `docs/`).

A repo is identified by its **path** (e.g. `~/code/acme-app`). An optional alias
name can be configured and used instead (e.g. `app`). Paths are first-class —
prefer passing a path; you don't need to pre-configure anything.

## When to use this

- The user asks to work on a repo and you're starting from outside any checkout
  (e.g. from `~`) → use `wt up <path>` to get a worktree, then `cd` into it.
- The user is done with a worktree / the PR is merged → use `wt down`.
- You want to see what's available → `wt list` (alias `wt ls`).

Do **not** use `wt` if the user is already working inside an existing checkout
and just wants you to keep editing there.

## Core workflow

```bash
# 1. get a ready worktree by PATH (instant from pool; cold-builds if empty).
#    If the path isn't configured yet, wt auto-registers it (no TTY = agent),
#    detecting a setup command like `pnpm install`.
path="$(wt up ~/code/acme-app --path-only)"

# 2. work in it
cd "$path"
git switch -c feature/<name>        # create a branch for the work
# ...edit, commit, push, open PR...

# 3. release it back to the pool when done
wt down
```

Once a repo has an alias configured, you can use it instead of the path:

```bash
wt up app                            # by alias (if configured)
```

## Commands

| Command                    | Use                                                          |
| -------------------------- | ------------------------------------------------------------ |
| `wt up <repo>`             | Get a ready worktree. `--path-only` prints just the path. `<repo>` = path or alias. Auto-sets-up an unconfigured path. |
| `wt down [<id>]`           | Release a worktree (defaults to the one for the cwd). Refuses if it has unsaved work; `--force` overrides. |
| `wt list [<repo>]`         | List all worktrees + status (alias `wt ls`).                 |
| `wt config`                | Show + validate configured repos.                            |
| `wt config <repo> [flags]` | Add / edit a repo (path or alias; see below).                |
| `wt prewarm <repo>`        | Warm the pool ahead of time.                                 |

All commands accept `--json` for machine-readable output. Prefer `--json` when
you need to parse results.

## Agent guidance

- To start work: `cd "$(wt up <path> --path-only)"`, then create a branch.
  Passing a path Just Works even for a repo `wt` has never seen — it
  auto-registers it (no prompts when there's no TTY).
- The path `wt up` returns is an absolute path under the configured
  `worktreeRoot` (defaults under `~/.wt`). Always `cd` there before doing repo
  work.
- A handed-out worktree is **detached** — create a branch before committing
  with `git switch -c <name>`.
- Worktrees may have been warmed a while ago (`wt up` prints "warmed Nd ago").
  If the user needs the very latest base branch, run `git fetch` +
  `git rebase origin/<base>` (or `git pull`) in the worktree.
- When work is finished and merged, run `wt down` to return the worktree to the
  pool. This is cheap and keeps the environment warm for reuse.

## Releasing safely

`wt down` resets the worktree to its base branch, so it **refuses to release a
worktree with unsaved work** — uncommitted changes, or commits on a branch not
pushed to a remote. This guard is intentional:

- If `wt down` reports unsaved work, **don't blindly `--force`**. Commit and
  push (or stash) the work first, then release.
- Only use `wt down --force` when the user explicitly wants to discard the
  worktree's state (the branch ref still survives in the source repo, so
  committed work remains recoverable).
- `wt list` shows each worktree's id, repo, status, branch, age, and path.
  `--json` adds `liveBranch`, `liveCommit`, `ahead`, and `behind`. (Listing is
  cheap and does **not** run `git status`; `wt down` does the full unsaved-work
  check when it actually matters.)

## Tracking which worktree is yours (--meta)

`wt up` records who attached a worktree, so you can find it again later:

- `sessionInfo` — auto-captured: the attaching process's `pid`, `process`,
  `command`, and `cwd`.
- `sessionMeta` — whatever you pass via `--meta` (a JSON object).

Tag a worktree with your own session id (and anything else useful) when you take
it, then locate it later by filtering `wt list --json` on `sessionMeta`:

```bash
# take a worktree and stamp it with your session id + task
path="$(wt up ~/code/acme-app --path-only --meta '{"sessionId":"<your-session-id>","task":"luc/feature"}')"
cd "$path"

# later: find the worktree this session started
wt list --json | jq '.[] | select(.sessionMeta.sessionId == "<your-session-id>")'
```

Both fields are informational only — `wt` never reclaims or destroys a worktree
based on them, even if the recorded pid is long dead. They're cleared on
`wt down`.

## Configuring / tuning a repo (optional)

`wt up <path>` auto-registers with sensible defaults, so you rarely need this.
To set an alias or tune pool size / setup non-interactively:

```bash
wt config ~/code/acme-app --name app --yes --json
# pool knobs: --min-warm (floor), --max-warm (warm cap), --max-total (hard cap)
wt config ~/code/acme-app --setup 'pnpm install' --min-warm 1 --max-warm 5 --max-total 25 --yes
wt config ~/code/notes --no-setup --yes
```

Pool sizing has three knobs: `minWarmPool` (always keep this many ready),
`maxWarmPool` (pre-build up to this many warm), and `maxTotalPool` (hard cap on
worktrees on disk, e.g. for many concurrent branches).

See <https://github.com/lucleray/wt/blob/main/docs/config.md> for the full
reference.

## Troubleshooting

| Symptom                              | Cause / fix                                              |
| ------------------------------------ | -------------------------------------------------------- |
| `not a git repo: <path>`             | The path isn't a git repo. Check the path.               |
| `up` is slow + "cold start" warning  | Pool was empty; it built one and is refilling in the bg. |
| `not inside a managed worktree`      | `wt down` was run outside a worktree. Pass an id.        |
| `refusing to release ... unsaved work` | The worktree has uncommitted/unpushed work. Commit + push first, or `--force` to discard. |
