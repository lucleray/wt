# wt

```
      /\                                  /\
     //\\              /\                //\\
    ///\\\    /\      //\\                ||       /\
      ||     //\\    ///\\\   █   █ ███           //\\    /\
        /\    ||       ||     █ █ █  █       /\  ///\\\  //\\
       //\\                   ██ ██  █      //\\   ||     ||
        ||                                 ///\\\
                                             ||

  warm git worktrees, instantly  〜
```

Agent-first git worktree pool manager. Get a ready-to-work copy of any repo
**instantly** by handing out a pre-warmed git worktree from a pool.

## Why

- **Instant.** Checkout + `pnpm install` is pre-paid in the background, so
  `wt up` hands you a warm worktree with deps already installed.
- **Zero setup.** Point it at a repo path and it self-configures (auto-detects
  `pnpm install`, `cargo fetch`, etc.) — no config file to write.
- **Agent-friendly.** `cd "$(wt up <path> --path-only)"` Just Works with no
  prompts; everything supports `--json`.
- **Safe.** Never auto-deletes worktrees, and `wt down` refuses to recycle
  unsaved work.

## Install

```sh
pnpm install && pnpm build && pnpm link --global   # exposes the `wt` command
```

## Use

```sh
cd "$(wt up ~/code/acme-app --path-only)"   # warm worktree, ready to go
git switch -c my-feature                    # ...work, commit, push, open a PR...
wt down                                      # release it back to the pool
```

That's it. The first `wt up <path>` bootstraps config automatically; later you
can use a short alias (`wt up app`). Requires Node 20+ and `git`.

---

## Commands

| Command                  | Description                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| `wt up <repo>`           | Get a ready worktree (instant from pool); `<repo>` = path or alias. |
| `wt down [<id>]`         | Release a worktree back to the pool (defaults to the cwd's).      |
| `wt list [<repo>]`       | List all worktrees and their status (alias: `wt ls`).             |
| `wt config`              | Print and validate the config (incl. pool bounds).                |
| `wt config <repo>`       | Add / edit a repo (interactive, or via flags for agents).         |
| `wt prewarm <repo>`      | Warm the pool to `minPool` ready worktrees.                       |

All commands accept `--json` for machine-readable output. `wt up` also accepts
`--path-only` (print just the path) and `--skip-setup` (on a cold build, skip
the repo's setup script). `wt down` accepts `--force` (release even with unsaved
work). See [docs/usage.md](docs/usage.md) for full details.

## How it works

`wt` keeps a small **pool** of worktrees per repo that are already checked out
and set up. Asking for one (`wt up`) is near-instant; releasing it (`wt down`)
returns it to the pool to be reused, and a background top-up keeps the pool
full. A repo is identified by its **path**; an optional `name` gives it a short
alias.

See [docs/design.md](docs/design.md) for the architecture (pool lifecycle, state
management, freshness, concurrency) and [docs/config.md](docs/config.md) for
configuration.

## Tests

End-to-end tests drive the built CLI against throwaway repos in an isolated
config dir (your real `~/.wt` is never touched):

```sh
pnpm test
```

## Status

v1 — daemon-less, lazy top-up, reuse-on-release. Designed for a single user
across many local repos.
