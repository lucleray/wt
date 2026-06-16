import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { configDir } from "./config.js";

export type WorktreeStatus =
  | "ready" // fully built + set up, idle, healthy
  | "attached" // handed out to a session
  | "needs-resetup" // released, waiting to be reset + re-set-up
  // transitional states (a worker is actively operating; recoverable if stale)
  | "building" // git worktree add + setup script running
  | "resetting" // git reset --hard + re-setup running
  | "destroying"; // git worktree remove running

/**
 * Auto-captured details about the session that attached a worktree. Purely
 * informational — `wt` never acts on a (possibly-dead) pid, so this is safe to
 * be stale. See `captureSession` in util.ts.
 */
export interface SessionInfo {
  /** PID of the process that ran `wt up` (its parent — the shell/agent). */
  pid: number | null;
  /** Short process name of that pid (e.g. "opencode"), best-effort. */
  process: string | null;
  /** Full command line of that pid, best-effort, length-clamped. */
  command: string | null;
  /** Working directory the worktree was handed out to. */
  cwd: string;
  /** Epoch seconds when it was attached. */
  attachedAt: number;
}

/** States where a worker process is mid-operation and a crash leaves junk. */
export interface Worktree {
  id: string;
  repo: string;
  path: string;
  status: WorktreeStatus;
  branch: string | null;
  owner: string | null;
  baseCommit: string | null;
  warmedAt: number | null;
  attachedAt: number | null;
  /** PID of the worker performing a transitional operation, if any. */
  workerPid: number | null;
  /** Epoch seconds when the current transitional state was entered. */
  enteredAt: number | null;
  /** Auto-captured info about the attaching session (null when not attached). */
  sessionInfo: SessionInfo | null;
  /** Arbitrary metadata the caller passed via `wt up --meta` (e.g. an agent's
   * session id). Informational; null when not attached or none provided. */
  sessionMeta: Record<string, unknown> | null;
}

export interface State {
  worktrees: Worktree[];
}

function statePath(): string {
  return join(configDir(), "state.json");
}

function lockPath(): string {
  return statePath() + ".lock";
}

function emptyState(): State {
  return { worktrees: [] };
}

/**
 * Acquire a named lock, blocking (with retry) until available. Used to
 * serialize git operations on a shared source repo across processes.
 */
export function withNamedLockSync<T>(name: string, fn: () => T): T {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const release = tryNamedLock(name);
    if (release) {
      try {
        return fn();
      } finally {
        release();
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out acquiring lock "${name}"`);
    }
    // Busy-wait briefly (sync context). Small sleep via Atomics.
    sleepSync(50);
  }
}

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

/**
 * Try to acquire a named non-blocking lock (e.g. per-repo top-up serialization).
 * Returns a release function if acquired, or null if already held by a live
 * process. Steals stale locks whose holder pid is dead.
 */
export function tryNamedLock(name: string): (() => void) | null {
  const lock = join(configDir(), `${name}.lock`);
  mkdirSync(dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lock);
        } catch {
          /* ignore */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Held — steal if the holder is dead, else give up.
      let holderDead = true;
      try {
        const pid = parseInt(readFileSync(lock, "utf8").trim(), 10);
        if (Number.isFinite(pid)) {
          try {
            process.kill(pid, 0);
            holderDead = false;
          } catch {
            holderDead = true;
          }
        }
      } catch {
        holderDead = true;
      }
      if (holderDead) {
        try {
          unlinkSync(lock);
        } catch {
          /* ignore */
        }
        continue; // retry once
      }
      return null; // live holder
    }
  }
  return null;
}

export function readState(): State {
  const p = statePath();
  if (!existsSync(p)) return emptyState();
  try {
    return JSON.parse(readFileSync(p, "utf8")) as State;
  } catch {
    return emptyState();
  }
}

function writeState(state: State): void {
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  // Unique temp name per writer so concurrent writers never clobber or race on
  // the same temp file (rename is atomic; the last writer under the lock wins).
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, p);
}

/**
 * Acquire an exclusive lock via O_EXCL lockfile, run fn with mutable state,
 * persist the result, and release the lock. Retries on contention.
 */
export async function withState<T>(
  fn: (state: State) => T | Promise<T>,
): Promise<T> {
  const lock = lockPath();
  mkdirSync(dirname(lock), { recursive: true });
  const acquired = await acquireLock(lock);
  let fd = acquired;
  try {
    const state = readState();
    const result = await fn(state);
    writeState(state);
    return result;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(lock);
    } catch {
      /* ignore */
    }
  }
}

async function acquireLock(lock: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      writeFileSync(fd, String(process.pid));
      return fd;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Stale lock? If the holding pid is gone, steal it.
      if (isStaleLock(lock)) {
        try {
          unlinkSync(lock);
        } catch {
          /* ignore */
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out acquiring state lock at ${lock}`);
      }
      await sleep(50);
    }
  }
}

function isStaleLock(lock: string): boolean {
  try {
    const pid = parseInt(readFileSync(lock, "utf8").trim(), 10);
    if (!Number.isFinite(pid)) return true;
    try {
      process.kill(pid, 0);
      return false; // process alive
    } catch {
      return true; // no such process
    }
  } catch {
    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- helpers operating on a State value ----

export function worktreesForRepo(state: State, repo: string): Worktree[] {
  return state.worktrees.filter((w) => w.repo === repo);
}

export function findById(state: State, id: string): Worktree | undefined {
  return state.worktrees.find((w) => w.id === id);
}

export function findByPath(state: State, path: string): Worktree | undefined {
  const norm = realish(path).replace(/\/$/, "");
  return state.worktrees.find((w) => {
    const wp = realish(w.path).replace(/\/$/, "");
    return norm === wp || norm.startsWith(wp + "/");
  });
}

/** Resolve symlinks (e.g. macOS /var -> /private/var) when the path exists. */
function realish(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function removeWorktree(state: State, id: string): void {
  state.worktrees = state.worktrees.filter((w) => w.id !== id);
}
