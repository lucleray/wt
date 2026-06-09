#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  cmdUp,
  cmdDown,
  cmdList,
  cmdStatus,
  cmdPrewarm,
  cmdGc,
  cmdConfig,
  cmdTopup,
  type CmdOpts,
} from "./commands.js";

const HELP = `wt — agent-first git worktree pool manager

Usage:
  wt up <repo> [branch]   Get a ready worktree (instant from pool)
  wt down [<id>]          Release a worktree back to the pool
  wt list [<repo>]        List worktrees and their status
  wt status               Show pool health per repo
  wt prewarm <repo> [-n N] Build N ready worktrees
  wt gc                   Prune stale/removed worktrees
  wt config               Print and validate config

Options:
  --json        Machine-readable output
  --path-only   (up) Print only the worktree path
  -n <N>        (prewarm) build hint (currently fills to minPool)
  -h, --help    Show help
  -v, --version Show version
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === "-v" || cmd === "--version") {
    process.stdout.write("0.1.0\n");
    return;
  }

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      "path-only": { type: "boolean" },
      n: { type: "string" },
    },
  });

  const opts: CmdOpts = {
    json: values.json as boolean | undefined,
    pathOnly: values["path-only"] as boolean | undefined,
    n: values.n ? parseInt(values.n as string, 10) : undefined,
  };

  switch (cmd) {
    case "up":
      requireArg(positionals[0], "wt up <repo> [branch]");
      await cmdUp(positionals[0], positionals[1], opts);
      break;
    case "down":
      await cmdDown(positionals[0], opts);
      break;
    case "list":
    case "ls":
      await cmdList(positionals[0], opts);
      break;
    case "status":
      await cmdStatus(opts);
      break;
    case "prewarm":
      requireArg(positionals[0], "wt prewarm <repo>");
      await cmdPrewarm(positionals[0], opts);
      break;
    case "gc":
      await cmdGc(opts);
      break;
    case "config":
      await cmdConfig(opts);
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
