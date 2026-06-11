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

Agent-first git worktree pool manager. Spin up a ready-to-work copy of any
configured repo **instantly** by handing out a pre-warmed git worktree from a
pool.

```sh
wt up ~/code/acme-app      # first time: offers to set it up, then hands you a worktree
cd "$(wt up ~/code/acme-app --path-only)"
# ...work, commit, open a PR...
wt down                   # release the worktree back to the pool
```

A repo is identified by its **path**. The first time you `up` an unconfigured
path, `wt` sets it up (auto-detecting a setup command like `pnpm install`). You
can also give a repo a short **alias** and use that instead (`wt up app`).

The slow part of starting work in a big repo — checking out and running
`pnpm install` (or whatever your setup is) — is **pre-paid in the background**.
By the time you ask for a worktree, one is already warm and waiting.

## Why

Starting fresh work in a large monorepo is slow:

- `git worktree add` + checkout
- `pnpm install` over thousands of packages

`wt` keeps a small **pool** of worktrees per repo that are already checked out
and set up. Asking for one (`wt up`) is near-instant; releasing it (`wt down`)
returns it to the pool to be reused. A background top-up keeps the pool full.

This is built to be driven by coding agents: an agent started in `~/w` can run
`wt up <path>`, `cd` into the printed path, and start working immediately —
no manual environment juggling.

## Install

```sh
pnpm install
pnpm build
pnpm link --global   # exposes the `wt` command
```

Requires Node 20+ and `git`. Per-repo setup scripts (e.g. `pnpm install`) run
in the worktree, so whatever those need must be available too.

No config file is needed to start — the first `wt up <path>` bootstraps it for
you (creating `~/.wt/config.jsonc` and registering the repo automatically).

## Quick start

Just point `wt` at a repo path — it sets it up on first use:

```sh
wt up ~/code/acme-app
```

That detects the repo, suggests a setup command, registers it (writing
`~/.wt/config.jsonc` on first run), and hands you a worktree. To pre-warm without working yet, or to tune settings, use
`wt config ~/code/acme-app` (see [docs/config.md](docs/config.md)). The config is
keyed by repo path; an optional `name` gives you a short alias.

## Commands

| Command                  | Description                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| `wt up <repo>`           | Get a ready worktree (instant from pool); `<repo>` = path or alias. |
| `wt down [<id>]`         | Release a worktree back to the pool (defaults to the cwd's).      |
| `wt list [<repo>]`       | List all worktrees and their status (alias: `wt ls`).             |
| `wt config`              | Print and validate the config (incl. pool bounds).                |
| `wt config <repo>`       | Add / edit a repo (interactive, or via flags for agents).         |

### Advanced

| Command                  | Description                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| `wt prewarm <repo>`      | Warm the pool to `minPool` ready worktrees.                       |

All commands accept `--json` for machine-readable output. `wt up` also accepts
`--path-only` (print just the path) and `--skip-setup` (on a cold build, skip
the repo's setup script — handy on a bad connection).

See [docs/usage.md](docs/usage.md) for full details.

## How it works

See [docs/design.md](docs/design.md) for the architecture: pool lifecycle,
state management, freshness model, and concurrency.

## Status

v1 — daemon-less, lazy top-up, reuse-on-release. Designed for a single user
across many local repos.
