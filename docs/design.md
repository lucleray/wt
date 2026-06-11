# Design

`wt` manages a **pool** of pre-warmed git worktrees per repo so that acquiring a
ready-to-work environment is instant.

## Mental model

```
~  (agent starts here, no repo)
  │  "work on a PR in acme-app"
  ▼
wt up app ──► pop a READY worktree from the pool ──► print its path (instant)
  │                                                   └─ background: top up pool
  ▼
work in ~/.wt/worktrees/acme-app/wt-ab12  (deps already installed)
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
   (none) ──building──► ready ──up──► attached ──down──► needs-resetup
                          ▲                                    │
                          │                                    │ top-up claims it
                          │                                    ▼
                          └──────────── resetting ◄────────────┘
                                            │
                          (over capacity)   │
                                            ▼
                                       destroying ──► (gone)
```

States fall into two groups:

**Settled** (stable, safe to trust):

- **ready** — fully built, setup succeeded, idle, available to hand out.
- **attached** — claimed by a session (records cwd + timestamp).
- **needs-resetup** — released; waiting to be reset + re-set-up before reuse.

**Transitional** (a worker process is mid-operation):

- **building** — `git worktree add --detach` + setup script running.
- **resetting** — `git reset --hard <base>` + re-setup running (reuse path).
- **destroying** — `git worktree remove` running.

Each transitional record carries the operating process's `workerPid` and the
`enteredAt` timestamp, which is what makes crash recovery deterministic (see
below).

### Empty pool

If `wt up` finds no `ready` worktree, it **builds one on demand** (blocking)
and warns that this is a cold start, then triggers a background top-up. So `up`
never fails — it is just occasionally slow.

### Reuse on release (minPool / maxPool)

`wt down` is **instant**: it detaches HEAD and marks the worktree
`needs-resetup` rather than re-running setup synchronously. The actual
`git reset --hard origin/<base>` + setup happens during the next background
top-up. This keeps the warm `node_modules` and avoids blocking the user on
`down`.

The top-up balances the pool against two bounds:

- It refills toward **`minPool`** (the warm floor) — reusing released worktrees
  first (cheap reset, keeps deps), then building new ones if needed.
- A released worktree is **kept and reused** as long as the total worktree count
  is within **`maxPool`**. Only when the total would exceed `maxPool` is a
  released worktree destroyed.

So with `minPool: 1, maxPool: 5`, bouncing `up`/`down` recycles warm worktrees
up to 5 before any are torn down — avoiding the churn of deleting and
reinstalling on every release.

### Freshness

Worktrees are handed out **as-is** (v1 choice). A worktree warmed days ago is
checked out at an older base commit. `wt up` prints how long ago it was warmed
so the agent/user can `git pull --rebase` if they need the latest. There is no
automatic reset on hand-out (that would make `up` slow and defeat the point).

## Background top-up

There is **no daemon** in v1. Top-up is triggered lazily by `up` and `down`:
after handing out or releasing a worktree, `wt` spawns a detached background
process (`wt __topup <repo>`) that rebalances the pool against `minPool` /
`maxPool`, building new worktrees or re-setting-up released ones as needed.

Top-ups are **serialized per repo** with a non-blocking lock (`topup-<repo>`):
if one is already running, a newly triggered one no-ops, since the running
top-up re-reads state each iteration and will pick up the latest changes.
Git operations that mutate the shared source repo's worktree registry
(`worktree add` / `remove` / `prune`) are serialized with a separate blocking
lock (`git-<repo>`) so concurrent builds don't race.

## State

State lives in `~/.wt/state.json`, guarded by a lockfile
(`~/.wt/state.json.lock`). Every mutating command:

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
  "repo": "acme-app",
  "path": "/Users/you/.wt/worktrees/acme-app/wt-ab12",
  "status": "ready",        // ready | attached | needs-resetup | building | resetting | destroying
  "branch": null,           // branch name if attached with one, else null (detached)
  "owner": null,            // cwd/session that holds it when attached
  "baseCommit": "a27ab96",  // commit it was warmed at
  "warmedAt": 1700000000,   // epoch seconds
  "attachedAt": null,
  "workerPid": null,        // pid of the worker doing a transitional op, if any
  "enteredAt": null         // when the current transitional state was entered
}
```

## Crash recovery

If the machine shuts down (or a worker is killed) mid-operation, work can be
left half-done: a stuck transitional record, a half-built worktree dir, or a
git-registered worktree wt's state never recorded. A **reconcile pass** cleans
all of this up. It runs automatically at the start of `wt up`.

Reconcile does three things:

1. **Stale transitional records.** A record in `building` / `resetting` /
   `destroying` is considered crashed if its `workerPid` is no longer alive, or
   (as a fallback for missing pids) if it has sat in that state longer than a
   generous threshold. Stale records are removed along with any dir they left
   behind. A transitional record whose worker is **still alive** is always left
   untouched — its dir may not exist yet because the build is still running.

2. **Vanished dirs.** Settled records (`ready` / `attached` / `needs-resetup`)
   whose worktree dir no longer exists on disk are dropped.

3. **Orphan worktrees.** Worktrees git knows about that live inside the managed
   `worktreeRoot/<repo>/` tree but have no backing state record (e.g. a build
   that created the worktree, then crashed before recording it) are force
   removed. The sweep is scoped strictly to the pool dir, so unrelated
   worktrees are never touched.

Two properties make this safe:

- **`ready` is the only health signal.** A worktree only reaches `ready` after
  its setup script fully succeeds, so a half-installed worktree is never handed
  out — no sentinel file is written into the working tree (which would risk
  being committed).
- **Atomic state writes.** State is written via temp-file + rename, so a crash
  mid-write leaves the previous valid state intact. The lockfile is
  pid-aware, so a dead holder's lock is reclaimed automatically.

## Config

See [config.md](config.md). Setup is intentionally **a shell script string**,
not pnpm-specific, so any repo/toolchain works.

## Layout

```
~/.wt/config.jsonc            # user-edited config
~/.wt/state.json              # tool-managed pool state
~/.wt/state.json.lock         # lockfile
~/.wt/worktrees/<repo>/wt-<id>/   # the pooled worktrees
```

## Non-goals (v1)

- No daemon / always-on freshness.
- No automatic migration of existing manual copies (e.g. `acme-app2`, `acme-app3`).
- No remote/sandbox worktrees — local only.
