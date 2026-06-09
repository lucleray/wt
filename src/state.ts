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

/** States where a worker process is mid-operation and a crash leaves junk. */
export const TRANSITIONAL: WorktreeStatus[] = [
  "building",
  "resetting",
  "destroying",
];

export function isTransitional(status: WorktreeStatus): boolean {
  return TRANSITIONAL.includes(status);
}

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
  const tmp = p + ".tmp";
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
