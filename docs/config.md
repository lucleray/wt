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

      // How many ready worktrees to keep warm. Default: 1.
      "poolSize": 2
    }
  }
}
```

## Fields

| Field                 | Required | Default        | Description                                              |
| --------------------- | -------- | -------------- | -------------------------------------------------------- |
| `worktreeRoot`        | no       | `~/w/worktrees`| Root dir for all pooled worktrees.                       |
| `repos.<name>.source` | yes      | —              | Local git repo worktrees are created from.               |
| `repos.<name>.baseBranch` | no   | `main`         | Branch to warm worktrees at.                             |
| `repos.<name>.setup`  | no       | (none)         | Shell command run in each worktree after checkout.       |
| `repos.<name>.poolSize` | no     | `1`            | Number of ready worktrees to keep warm.                  |

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
