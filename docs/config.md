# Configuration

Repos are identified by their **path**. You usually don't touch the config file
directly — just `wt up <path>` and `wt` sets the repo up on first use. To
configure ahead of time or tweak settings, use `wt config <repo>`.

`wt` stores config in `~/.config/wt/config.jsonc` (JSONC — comments allowed).
Override the path with `WT_CONFIG`.

## `wt config <repo>` — add or edit a repo

`<repo>` is a path (e.g. `~/w/vercel/api`) or an existing alias.

Interactive (humans): run it in a terminal and answer the prompts. It
auto-suggests a setup command from the repo's files (e.g. `pnpm install` if it
finds `pnpm-lock.yaml`) and lets you set an optional alias name.

```sh
wt config ~/w/vercel/api
```

Non-interactive (agents / scripts): pass flags. When any flag is given (or
there's no TTY, or `--yes`), prompts are skipped.

```sh
# Add a repo (setup auto-suggested)
wt config ~/w/vercel/api --yes

# Give it an alias + override fields
wt config ~/w/vercel/api --name api --setup 'pnpm install --frozen-lockfile' --max 8 --yes

# No setup command
wt config ~/w/notes --no-setup --yes
```

Flags:

| Flag              | Meaning                                                  |
| ----------------- | -------------------------------------------------------- |
| `--name <alias>`  | Optional friendly alias for the repo.                    |
| `--base <branch>` | Base branch (default: `main`).                           |
| `--setup <cmd>`   | Setup command. If omitted on a new repo, it's suggested. |
| `--no-setup`      | Explicitly set no setup command.                         |
| `--min <n>`       | Min pool size (default: `1`).                            |
| `--max <n>`       | Max pool size (default: `5`).                            |
| `--source <path>` | Source path (usually just pass the path as `<repo>`).    |
| `--yes`           | Skip prompts / accept defaults.                          |
| `--json`          | Machine-readable result.                                 |

Editing an existing repo only changes the fields you pass; the rest are kept.
Writing the config reformats it as JSON, so hand-written comments are not
preserved.

## Shape

The config is **keyed by repo path**. Each entry's optional `name` is a
nice-to-have alias.

```jsonc
{
  // Where pooled worktrees are created. Default: ~/w/worktrees
  "worktreeRoot": "~/w/worktrees",

  "repos": {
    // key = the repo's source path (this IS the identity)
    "~/w/vercel/api": {
      // Optional short alias, so you can `wt up api`.
      "name": "api",

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

> Worktrees are stored under `worktreeRoot/<basename>-<hash>/` where the hash is
> derived from the repo path, so repos that share a folder name never collide.

> **Back-compat:** older configs that keyed repos by name and stored the path in
> a `source` field are still read; the old name becomes the alias, and the file
> is migrated to the path-keyed shape the next time you run `wt config`.

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

The repo entry is keyed by `<path>` (the source). Fields on each entry:

| Field                     | Required | Default         | Description                                            |
| ------------------------- | -------- | --------------- | ------------------------------------------------------ |
| `worktreeRoot`            | no       | `~/w/worktrees` | Root dir for all pooled worktrees.                     |
| `repos.<path>.name`       | no       | —               | Optional alias you can pass instead of the path.       |
| `repos.<path>.baseBranch` | no       | `main`          | Branch to warm worktrees at.                           |
| `repos.<path>.setup`      | no       | (none)          | Shell command run in each worktree after checkout.     |
| `repos.<path>.minPool`    | no       | `1`             | Warm floor: keep at least this many `ready`.           |
| `repos.<path>.maxPool`    | no       | `minPool`       | Total ceiling before released worktrees are destroyed. |
| `repos.<path>.poolSize`   | no       | —               | Alias: sets both `minPool` and `maxPool` (legacy).     |

## Path expansion

`~` and environment variables are expanded in repo paths and `worktreeRoot`.

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
