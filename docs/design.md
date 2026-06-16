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

### Reuse on release (minWarmPool / maxWarmPool / maxTotalPool)

`wt down` is **instant**: it detaches HEAD and marks the worktree
`needs-resetup` rather than re-running setup synchronously. The actual
`git reset --hard origin/<base>` + setup happens during the next background
top-up. This keeps the warm `node_modules` and avoids blocking the user on
`down`.

The top-up balances the pool against three bounds:

- **`minWarmPool`** — the warm floor. At least this many `ready` worktrees are
  always kept available.
- **`maxWarmPool`** — the warm ceiling. The top-up grows the warm pool toward
  this many `ready` worktrees (reusing released ones first — cheap reset, keeps
  deps — then building new ones), and never keeps more than this idle. A
  released worktree beyond the warm cap is destroyed rather than kept warm.
- **`maxTotalPool`** — the total ceiling. The pool never grows beyond this many
  worktrees on disk (warm + in-use + recycling). This is the hard backstop on
  disk usage.

So with `minWarmPool: 1, maxWarmPool: 5, maxTotalPool: 25`, bouncing `up`/`down`
recycles warm worktrees up to 5 before surplus is torn down, while still
allowing up to 25 worktrees to exist at once when many branches are checked out.

### Freshness

Worktrees are handed out **as-is** (v1 choice). A worktree warmed days ago is
checked out at an older base commit. `wt up` prints how long ago it was warmed
so the agent/user can `git pull --rebase` if they need the latest. There is no
automatic reset on hand-out (that would make `up` slow and defeat the point).

## Background top-up

There is **no daemon** in v1. Top-up is triggered lazily by `up` and `down`:
after handing out or releasing a worktree, `wt` spawns a detached background
process (`wt __topup <repo>`) that rebalances the pool against `minWarmPool` /
`maxWarmPool` / `maxTotalPool`, building new worktrees or re-setting-up released
ones as needed.

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
  "enteredAt": null,        // when the current transitional state was entered
  "sessionInfo": null,      // auto-captured attaching session: { pid, process, command, cwd, attachedAt }
  "sessionMeta": null       // caller-supplied metadata from `wt up --meta` (e.g. an agent's session id)
}
```

`sessionInfo` and `sessionMeta` are populated on `wt up` (cleared on `wt down`).
`sessionInfo` is auto-detected — the parent process that ran `wt up` (the
shell/agent), captured best-effort via `ps`. `sessionMeta` is an arbitrary JSON
object the caller passes (agents use it to tag a worktree with their session id
so they can find it later via `wt list --json`). Both are **purely
informational**: like a dead `owner`, a stale `sessionInfo.pid` is never a
signal to reclaim or destroy anything (see Crash recovery below).

## Crash recovery

`wt` never auto-deletes worktrees. There is intentionally **no reconcile/GC
pass** — a worktree you were handed is yours until you explicitly `wt down` it,
even across reboots or after the session that created it has exited. This is a
deliberate safety choice: it's common to close the program that started a
worktree and reopen a new session on it later, so a dead owner process must
**never** be treated as a signal to reclaim or destroy work.

Consequences:

- A worktree left `attached` after a reboot stays `attached`. Release it with
  `wt down <id>` when you're actually done; the pool tops up around it.
- A build that crashed mid-flight may leave a stuck transitional record or a
  half-built dir. These are not cleaned automatically; remove them by hand if
  needed (`git worktree remove`).

Two properties keep the pool safe regardless:

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
