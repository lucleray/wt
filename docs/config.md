# Configuration

`wt` reads `~/.config/wt/config.jsonc` (JSONC — comments allowed). Override the
path with `WT_CONFIG`.

## Shape

```jsonc
{
  // Where pooled worktrees are created. Default: ~/w/worktrees
  "worktreeRoot": "~/w/worktrees",

  "repos": {
    // key = the name you pass to `wt up <name>`
    "front": {
      // Path to the canonical local clone worktrees branch from. Required.
      "source": "~/w/vercel/front",

      // Base branch worktrees are warmed at. Default: "main".
      "baseBranch": "main",

      // Shell command run inside each worktree after checkout. Optional.
      // Runs with cwd = the worktree directory.
      "setup": "pnpm install",

      // Warm floor: always keep at least this many `ready` worktrees. Default 1.
      "minPool": 1,

      // Total ceiling: released worktrees are kept warm (reused) until the total
      // would exceed this; only then are they destroyed. Default = minPool.
      "maxPool": 5
    }
  }
}
```

## Pool sizing: minPool / maxPool

Two bounds control the pool:

- **`minPool`** — the warm floor. `wt` always tops up until at least this many
  worktrees are `ready`.
- **`maxPool`** — the total ceiling. When you release a worktree (`wt down`),
  it is **reset and kept warm** (reused) rather than destroyed, as long as the
  total worktree count stays within `maxPool`. Only worktrees beyond `maxPool`
  are destroyed.

This lets you avoid churn: with `minPool: 1, maxPool: 5` you always have at
least one warm worktree, and bouncing `up`/`down` reuses worktrees (keeping
their installed deps) until you have 5, instead of deleting and rebuilding each
time.

**`poolSize`** is a backwards-compatible alias: setting it is equivalent to
`minPool = maxPool = poolSize` (a fixed-size pool).

## Fields

| Field                     | Required | Default         | Description                                            |
| ------------------------- | -------- | --------------- | ------------------------------------------------------ |
| `worktreeRoot`            | no       | `~/w/worktrees` | Root dir for all pooled worktrees.                     |
| `repos.<name>.source`     | yes      | —               | Local git repo worktrees are created from.             |
| `repos.<name>.baseBranch` | no       | `main`          | Branch to warm worktrees at.                           |
| `repos.<name>.setup`      | no       | (none)          | Shell command run in each worktree after checkout.     |
| `repos.<name>.minPool`    | no       | `1`             | Warm floor: keep at least this many `ready`.           |
| `repos.<name>.maxPool`    | no       | `minPool`       | Total ceiling before released worktrees are destroyed. |
| `repos.<name>.poolSize`   | no       | —               | Alias: sets both `minPool` and `maxPool`.              |

## Path expansion

`~` and environment variables are expanded in `source` and `worktreeRoot`.

## Validating

```sh
wt config          # prints resolved config and reports problems
wt config --json   # machine-readable
```

`wt config` checks that each `source` exists and is a git repo, and that
`baseBranch` resolves.

## Examples

### A pnpm monorepo

```jsonc
{
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

### Multiple repos, different toolchains

```jsonc
{
  "repos": {
    "front": { "source": "~/w/vercel/front", "setup": "pnpm install", "poolSize": 2 },
    "api":   { "source": "~/w/vercel/api",   "setup": "pnpm install", "poolSize": 1 },
    "infra": { "source": "~/w/vercel/infra", "setup": "terraform init", "poolSize": 1 }
  }
}
```

### No setup step

```jsonc
{
  "repos": {
    "notes": { "source": "~/w/notes" }
  }
}
```
