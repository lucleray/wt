# Design

`wt` manages a **pool** of pre-warmed git worktrees per repo so that acquiring a
ready-to-work environment is instant.

## Mental model

```
~/w  (agent starts here, no repo)
  │  "work on a PR in front"
  ▼
wt up front ──► pop a READY worktree from the pool ──► print its path (instant)
  │                                                     └─ background: top up pool
  ▼
work in ~/w/worktrees/front/wt-ab12  (deps already installed)
  │  done
  ▼
wt down ──► return the worktree to the pool (reused, reset lazily)
```

A "worktree" here is a real `git worktree` of a configured **source** repo,
checked out **detached** at the repo's base branch, with the repo's **setup
script** already run (e.g. `pnpm install`).

## Why worktrees (not clones)

Worktrees share the source repo's `.git` object store, so:

- creating one does not duplicate history (cheap)
- with pnpm's global content store, `node_modules` is mostly hardlinks

The tradeoff is a **shared branch namespace** — branches created in a worktree
are visible in the source repo too. That is acceptable (and useful) for real PR
work.

## Pool lifecycle

Each worktree is a state machine:

```
            build (git worktree add + setup)
   (none) ───────────────────────────────► ready
                                              │
                                       up     │
                                              ▼
                                          attached
                                              │
                                       down   │
                                              ▼
                                       needs-resetup
                                              │
                            lazy top-up: reset --hard + setup
                                              │
                                              ▼
                                            ready   (or destroyed if over poolSize)
```

- **build**: `git fetch`, `git worktree add --detach origin/<base>`, run setup.
- **ready**: idle, set up, available to hand out.
- **attached**: claimed by a session (records cwd + timestamp).
- **needs-resetup**: released, dirty; will be reset + re-set-up before reuse.

### Empty pool

If `wt up` finds no `ready` worktree, it **builds one on demand** (blocking)
and warns that this is a cold start, then triggers a background top-up. So `up`
never fails — it is just occasionally slow.

### Reuse on release

`wt down` is **instant**: it detaches HEAD and marks the worktree
`needs-resetup` rather than re-running setup synchronously. The actual
`git reset --hard origin/<base>` + setup happens during the next background
top-up. This keeps the warm `node_modules` and avoids blocking the user on
`down`. If the pool is already at `poolSize`, the released worktree is destroyed
instead.

### Freshness

Worktrees are handed out **as-is** (v1 choice). A worktree warmed days ago is
checked out at an older base commit. `wt up` prints how long ago it was warmed
so the agent/user can `git pull --rebase` if they need the latest. There is no
automatic reset on hand-out (that would make `up` slow and defeat the point).

## Background top-up

There is **no daemon** in v1. Top-up is triggered lazily by `up` and `down`:
after handing out or releasing a worktree, `wt` spawns a detached background
process (`wt __topup <repo>`) that brings the `ready` count back to `poolSize`,
building new worktrees or re-setting-up released ones as needed.

## State

State lives in `~/.config/wt/state.json`, guarded by a lockfile
(`~/.config/wt/state.json.lock`). Every mutating command:

1. acquires the lock
2. reads state
3. mutates
4. writes state atomically (temp file + rename)
5. releases the lock

This makes concurrent agents safe (e.g. two `wt up` at once won't hand out the
same worktree).

A worktree record:

```jsonc
{
  "id": "ab12",
  "repo": "front",
  "path": "/Users/you/w/worktrees/front/wt-ab12",
  "status": "ready",        // ready | attached | needs-resetup | building
  "branch": null,           // branch name if attached with one, else null (detached)
  "owner": null,            // cwd/session that holds it when attached
  "baseCommit": "a27ab96",  // commit it was warmed at
  "warmedAt": 1700000000,   // epoch seconds
  "attachedAt": null
}
```

## Config

See [config.md](config.md). Setup is intentionally **a shell script string**,
not pnpm-specific, so any repo/toolchain works.

## Layout

```
~/.config/wt/config.jsonc        # user-edited config
~/.config/wt/state.json          # tool-managed pool state
~/.config/wt/state.json.lock     # lockfile
~/w/worktrees/<repo>/wt-<id>/    # the pooled worktrees
```

## Non-goals (v1)

- No daemon / always-on freshness.
- No automatic migration of existing manual copies (e.g. `front2`, `front3`).
- No remote/sandbox worktrees — local only.
