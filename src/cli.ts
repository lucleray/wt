#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  cmdUp,
  cmdDown,
  cmdList,
  cmdPrewarm,
  cmdConfig,
  cmdConfigRepo,
  cmdTopup,
  type CmdOpts,
} from "./commands.js";
import { logo } from "./logo.js";

/** Read the package version from package.json (one dir up from dist/). */
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf8"),
    );
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

const HELP = `wt — agent-first git worktree pool manager

A <repo> is a path (e.g. ~/code/acme-app) or a configured alias (e.g. app).
The first time you 'up' an unconfigured path, wt offers to set it up.

Usage:
  wt up <repo>            Get a ready worktree (instant from pool)
  wt down [<id>]          Release a worktree back to the pool (refuses if it
                          has unsaved work; --force to override)
  wt list [<repo>]        List all worktrees and their status (alias: ls)
  wt config               Print and validate config
  wt config <repo>        Add / edit a repo (interactive, or via flags below)

Advanced:
  wt prewarm <repo>       Warm the pool to maxWarmPool

Options:
  --json        Machine-readable output
  --path-only   (up) Print only the worktree path
  --skip-setup  (up) On a cold build, skip the repo's setup script
  --meta <json> (up) Attach caller metadata as a JSON object; stored on the
                worktree and shown in 'wt list --json'. Handy for agents to
                tag a worktree with e.g. a session id so they can find it
                later: --meta '{"sessionId":"abc123","task":"luc/feature"}'
  --force       (down) Release even if the worktree has unsaved work

config <repo> flags (non-interactive — for agents/scripts):
  --name <alias>      Friendly alias for the repo (optional)
  --base <branch>     Base branch (default: main)
  --setup <cmd>       Setup command; auto-suggested from repo if omitted
  --no-setup          Explicitly set no setup command
  --min-warm <n>      Warm floor: always keep this many ready (default: 1)
  --max-warm <n>      Warm cap: pre-build up to this many ready (default: 5)
  --max-total <n>     Total cap: never exceed this many worktrees (default: 25)
  --min <n>           Alias for --min-warm (legacy)
  --max <n>           Alias for --max-total (legacy)
  --source <path>     Source path (usually just pass the path as <repo>)
  --yes               Skip prompts / accept defaults

  -h, --help    Show help
  -v, --version Show version
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd) {
    // Bare `wt`: show the logo then the help.
    process.stdout.write(logo() + "\n" + HELP);
    return;
  }
  if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === "-v" || cmd === "--version") {
    process.stdout.write(readVersion() + "\n");
    return;
  }

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      "path-only": { type: "boolean" },
      "skip-setup": { type: "boolean" },
      meta: { type: "string" },
      force: { type: "boolean" },
      source: { type: "string" },
      name: { type: "string" },
      base: { type: "string" },
      setup: { type: "string" },
      "no-setup": { type: "boolean" },
      "min-warm": { type: "string" },
      "max-warm": { type: "string" },
      "max-total": { type: "string" },
      min: { type: "string" },
      max: { type: "string" },
      yes: { type: "boolean" },
    },
  });

  const opts: CmdOpts = {
    json: values.json as boolean | undefined,
    pathOnly: values["path-only"] as boolean | undefined,
    skipSetup: values["skip-setup"] as boolean | undefined,
    meta: values.meta as string | undefined,
    force: values.force as boolean | undefined,
    source: values.source as string | undefined,
    name: values.name as string | undefined,
    baseBranch: values.base as string | undefined,
    setup: values.setup as string | undefined,
    noSetup: values["no-setup"] as boolean | undefined,
    // New 3-knob flags; --min / --max remain as legacy aliases
    // (--min -> warm floor, --max -> total cap).
    minWarmPool: intOpt(values["min-warm"] ?? values.min),
    maxWarmPool: intOpt(values["max-warm"]),
    maxTotalPool: intOpt(values["max-total"] ?? values.max),
    yes: values.yes as boolean | undefined,
  };

  switch (cmd) {
    case "up":
      requireArg(positionals[0], "wt up <repo>");
      await cmdUp(positionals[0], opts);
      break;
    case "down":
      await cmdDown(positionals[0], opts);
      break;
    case "list":
    case "ls":
      await cmdList(positionals[0], opts);
      break;
    case "prewarm":
      requireArg(positionals[0], "wt prewarm <repo>");
      await cmdPrewarm(positionals[0], opts);
      break;
    case "config":
      if (positionals[0]) await cmdConfigRepo(positionals[0], opts);
      else await cmdConfig(opts);
      break;
    case "__topup":
      // internal: background pool refill
      requireArg(positionals[0], "wt __topup <repo>");
      await cmdTopup(positionals[0]);
      break;
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

/** Parse an optional numeric flag string into a number (undefined if absent). */
function intOpt(val: unknown): number | undefined {
  if (typeof val !== "string") return undefined;
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : undefined;
}

function requireArg(val: string | undefined, usage: string): asserts val is string {
  if (!val) {
    process.stderr.write(`missing argument.\nusage: ${usage}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
