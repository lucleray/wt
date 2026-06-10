# wt

```
  ██     ██ ████████
  ██     ██    ██
  ██  █  ██    ██
  ██ ███ ██    ██
  ███████      ██
   ███ ███     ██

  warm git worktrees, instantly  〜
```

Agent-first git worktree pool manager. Spin up a ready-to-work copy of any
configured repo **instantly** by handing out a pre-warmed git worktree from a
pool.

```sh
wt up front      # -> /Users/you/w/worktrees/front/wt-ab12  (deps already installed)
cd "$(wt up front --path-only)"
# ...work, commit, open a PR...
wt down          # release the worktree back to the pool
```

The slow part of starting work in a big repo — cloning/checking out and running
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
`wt up <repo>`, `cd` into the printed path, and start working immediately —
no manual environment juggling.

## Install

```sh
pnpm install
pnpm build
pnpm link --global   # exposes the `wt` command
```

Requires Node 20+ and `git`. Per-repo setup scripts (e.g. `pnpm install`) run
in the worktree, so whatever those need must be available too.

## Quick start

1. Configure a repo (see [docs/config.md](docs/config.md)):

   ```jsonc
   // ~/.config/wt/config.jsonc
   {
     "worktreeRoot": "~/w/worktrees",
     "repos": {
       "front": {
         "source": "~/w/vercel/front",
         "baseBranch": "main",
         "setup": "pnpm install",
         "poolSize": 2
       }
     }
   }
   ```

2. Pre-warm the pool (optional — `up` will build on demand otherwise):

   ```sh
   wt prewarm front
   ```

3. Start working:

   ```sh
   wt up front
   ```

## Commands

| Command                  | Description                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| `wt up <repo> [branch]`  | Get a ready worktree (instant from pool). Optionally create a branch. |
| `wt down [<id>]`         | Release a worktree back to the pool (defaults to the cwd's).      |
| `wt list [<repo>]`       | List worktrees and their status.                                  |
| `wt status`              | Show pool health per repo.                                        |
| `wt prewarm <repo>`      | Warm the pool to `minPool` ready worktrees.                       |
| `wt gc`                  | Prune stale/removed worktrees.                                    |
| `wt config`              | Print and validate the config.                                    |

All commands accept `--json` for machine-readable output.

See [docs/usage.md](docs/usage.md) for full details.

## How it works

See [docs/design.md](docs/design.md) for the architecture: pool lifecycle,
state management, freshness model, and concurrency.

## Status

v1 — daemon-less, lazy top-up, reuse-on-release. Designed for a single user
across many local repos.
