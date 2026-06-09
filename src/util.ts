import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";

/** Expand ~ and $VARS in a path-like string. */
export function expandPath(p: string): string {
  let out = p;
  if (out.startsWith("~")) {
    out = homedir() + out.slice(1);
  }
  out = out.replace(/\$(\w+)|\$\{(\w+)\}/g, (_, a, b) => {
    const name = a || b;
    return process.env[name] ?? "";
  });
  return out;
}

/** Strip // and /* *\/ comments from JSONC. Naive but fine for config files. */
export function parseJsonc<T = unknown>(text: string): T {
  // Remove block comments, then line comments, being careful about strings.
  let result = "";
  let inString = false;
  let stringChar = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      result += ch;
      if (ch === "\\") {
        result += next ?? "";
        i += 2;
        continue;
      }
      if (ch === stringChar) inString = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      result += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    result += ch;
    i++;
  }
  // Remove trailing commas.
  result = result.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(result) as T;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command synchronously, capturing output. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): RunResult {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: "utf8",
  });
  return {
    code: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/** Run a command, throwing on non-zero exit. Returns trimmed stdout. */
export function runOrThrow(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const res = run(cmd, args, opts);
  if (res.code !== 0) {
    throw new Error(
      `command failed (${res.code}): ${cmd} ${args.join(" ")}\n${res.stderr.trim()}`,
    );
  }
  return res.stdout.trim();
}

/** Run a shell command string (for user-provided setup scripts). */
export function runShell(
  command: string,
  opts: { cwd?: string } = {},
): RunResult {
  const res = spawnSync(command, {
    cwd: opts.cwd,
    env: process.env,
    encoding: "utf8",
    shell: true,
  });
  return {
    code: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/** Spawn a fully detached background process that outlives this one. */
export function spawnDetached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export function shortId(): string {
  return Math.random().toString(36).slice(2, 6);
}

export function humanAge(epochSeconds: number): string {
  const secs = Math.floor(Date.now() / 1000) - epochSeconds;
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
