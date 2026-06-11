# Configuration

Repos are identified by their **path**. You usually don't touch the config file
directly — just `wt up <path>` and `wt` sets the repo up on first use. To
configure ahead of time or tweak settings, use `wt config <repo>`.

`wt` stores config in `~/.wt/config.jsonc` (JSONC — comments allowed).
Override the path with `WT_CONFIG`.

## `wt config <repo>` — add or edit a repo

`<repo>` is a path (e.g. `~/code/acme-app`) or an existing alias.

Interactive (humans): run it in a terminal and answer the prompts. It
auto-suggests a setup command from the repo's files (e.g. `pnpm install` if it
finds `pnpm-lock.yaml`) and lets you set an optional alias name.

```sh
wt config ~/code/acme-app
```

Non-interactive (agents / scripts): pass flags. When any flag is given (or
there's no TTY, or `--yes`), prompts are skipped.

```sh
# Add a repo (setup auto-suggested)
wt config ~/code/acme-app --yes

# Give it an alias + override fields
wt config ~/code/acme-app --name app --setup 'pnpm install --frozen-lockfile' --max-warm 8 --max-total 30 --yes

# No setup command
wt config ~/code/notes --no-setup --yes
```

Flags:

| Flag              | Meaning                                                  |
| ----------------- | -------------------------------------------------------- |
| `--name <alias>`   | Optional friendly alias for the repo.                    |
| `--base <branch>`  | Base branch (default: `main`).                           |
| `--setup <cmd>`    | Setup command. If omitted on a new repo, it's suggested. |
| `--no-setup`       | Explicitly set no setup command.                         |
| `--min-warm <n>`   | Warm floor: always keep this many `ready` (default: `1`).  |
| `--max-warm <n>`   | Warm cap: pre-build up to this many `ready` (default: `5`).|
| `--max-total <n>`  | Total cap: never exceed this many worktrees (default: `25`).|
| `--min <n>`        | Legacy alias for `--min-warm`.                           |
| `--max <n>`        | Legacy alias for `--max-total`.                          |
| `--source <path>`  | Source path (usually just pass the path as `<repo>`).    |
| `--yes`            | Skip prompts / accept defaults.                          |
| `--json`           | Machine-readable result.                                 |

Editing an existing repo only changes the fields you pass; the rest are kept.
Writing the config reformats it as JSON, so hand-written comments are not
preserved.

## Shape

The config is **keyed by repo path**. Each entry's optional `name` is a
nice-to-have alias.

```jsonc
{
  // Where pooled worktrees are created. Default: ~/.wt/worktrees
  "worktreeRoot": "~/.wt/worktrees",

  "repos": {
    // key = the repo's source path (this IS the identity)
    "~/code/acme-app": {
      // Optional short alias, so you can `wt up app`.
      "name": "app",

      // Base branch worktrees are warmed at. Default: "main".
      "baseBranch": "main",

      // Shell command run inside each worktree after checkout. Optional.
      // Runs with cwd = the worktree directory.
      "setup": "pnpm install",

      // Warm floor: always keep at least this many `ready` worktrees. Default 1.
      "minWarmPool": 1,

      // Warm ceiling: pre-build the pool up to this many `ready` worktrees in
      // the background (never more sit idle). Default 5.
      "maxWarmPool": 5,

      // Total ceiling: never grow the on-disk pool beyond this many worktrees
      // (warm + in-use + recycling). Default 25.
      "maxTotalPool": 25
    }
  }
}
```

> Worktrees are stored under `worktreeRoot/<basename>-<hash>/` where the hash is
> derived from the repo path, so repos that share a folder name never collide.

> **Back-compat:** older configs that keyed repos by name and stored the path in
> a `source` field are still read; the old name becomes the alias, and the file
> is migrated to the path-keyed shape the next time you run `wt config`.

## Pool sizing: minWarmPool / maxWarmPool / maxTotalPool

Three bounds control the pool, separating "how many to keep warm" from "how many
can exist at all":

- **`minWarmPool`** — the warm floor. `wt` always tops up until at least this
  many worktrees are `ready`.
- **`maxWarmPool`** — the warm ceiling. The background top-up pre-builds the pool
  up to this many `ready` worktrees, and never keeps more than this idle. When
  you release a worktree (`wt down`) it is reset and kept warm (reused) as long
  as the warm pool is below this cap; surplus released worktrees are destroyed.
- **`maxTotalPool`** — the total ceiling. The pool will never grow beyond this
  many worktrees on disk (warm + in-use + recycling). This is the hard backstop
  that bounds disk usage even when many worktrees are checked out at once.

So `minWarmPool: 1, maxWarmPool: 5, maxTotalPool: 25` means: always have ≥1 warm
worktree, keep up to 5 warm for instant handout, and allow up to 25 total before
`wt` stops creating new ones. This lets you have many long-lived branches checked
out (up to 25) while still keeping a fresh warm pool ready.

### Invariants

The three bounds are clamped on load so that
`minWarmPool ≤ maxWarmPool ≤ maxTotalPool` always holds — if you set them out of
order, the larger ones are raised to fit.

### Legacy aliases

Older configs are read transparently:

- **`minPool`** → `minWarmPool` (warm floor).
- **`maxPool`** → `maxTotalPool` (total ceiling).
- **`poolSize`** → a fixed-size pool (sets all three to the same value).

New keys win over legacy ones, and the file is rewritten to the new shape the
next time you run `wt config`.

## Fields

The repo entry is keyed by `<path>` (the source). Fields on each entry:

| Field                        | Required | Default           | Description                                            |
| ---------------------------- | -------- | ----------------- | ------------------------------------------------------ |
| `worktreeRoot`               | no       | `~/.wt/worktrees` | Root dir for all pooled worktrees.                     |
| `repos.<path>.name`          | no       | —                 | Optional alias you can pass instead of the path.       |
| `repos.<path>.baseBranch`    | no       | `main`            | Branch to warm worktrees at.                           |
| `repos.<path>.setup`         | no       | (none)            | Shell command run in each worktree after checkout.     |
| `repos.<path>.minWarmPool`   | no       | `1`               | Warm floor: keep at least this many `ready`.           |
| `repos.<path>.maxWarmPool`   | no       | `5`               | Warm ceiling: pre-build up to this many `ready`.       |
| `repos.<path>.maxTotalPool`  | no       | `25`              | Total ceiling: hard cap on worktrees on disk.          |
| `repos.<path>.minPool`       | no       | —                 | Legacy alias for `minWarmPool`.                        |
| `repos.<path>.maxPool`       | no       | —                 | Legacy alias for `maxTotalPool`.                       |
| `repos.<path>.poolSize`      | no       | —                 | Legacy alias: fixed-size pool (sets all three).        |

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
    "~/code/website": {
      "name": "website",
      "baseBranch": "main",
      "setup": "pnpm install",
      "minWarmPool": 1,
      "maxWarmPool": 5,
      "maxTotalPool": 25
    }
  }
}
```

### Multiple repos, different toolchains

```jsonc
{
  "repos": {
    "~/code/website":    { "name": "website", "setup": "pnpm install",   "maxWarmPool": 5, "maxTotalPool": 25 },
    "~/code/api-server": { "name": "api",     "setup": "pnpm install",   "maxWarmPool": 3, "maxTotalPool": 15 },
    "~/code/infra":      { "name": "infra",   "setup": "terraform init", "maxWarmPool": 1, "maxTotalPool": 5  }
  }
}
```

### No setup step

```jsonc
{
  "repos": {
    "~/code/notes": { "name": "notes" }
  }
}
```
