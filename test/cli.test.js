// End-to-end tests driving the built CLI (dist/cli.js) against throwaway repos
// and an isolated config dir, so nothing touches the user's real ~/.wt.
//
// Run with: pnpm test  (builds first, then `node --test`)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");

let root; // throwaway working area
let cfgDir; // isolated WT_CONFIG_DIR
let repo; // a fake git repo to manage

/** Run the wt CLI; returns { code, stdout, stderr }. Never throws on non-zero. */
function wt(args, opts = {}) {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      env: { ...process.env, WT_CONFIG_DIR: cfgDir, NO_COLOR: "1" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return {
      code: e.status ?? 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

/** Run git in a given cwd, throwing on failure. */
function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function listJson(repoArg) {
  const r = wt(repoArg ? ["list", repoArg, "--json"] : ["list", "--json"]);
  assert.equal(r.code, 0, `list --json failed: ${r.stderr}`);
  return JSON.parse(r.stdout || "[]");
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "wt-test-"));
  cfgDir = join(root, "cfg");
  repo = join(root, "repo");
  // Build a minimal git repo with one commit on main.
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# test\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
});

after(async () => {
  // A detached background top-up may still be writing into the pool dir, so
  // retry the cleanup a few times to avoid a racy ENOTEMPTY.
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
});

test("cold start on a pristine config dir bootstraps + hands out a worktree", () => {
  const r = wt(["up", repo, "--path-only"]);
  assert.equal(r.code, 0, `up failed: ${r.stderr}`);
  const path = r.stdout.trim();
  assert.ok(path.length > 0, "expected a worktree path on stdout");
  // It must be a usable git worktree.
  assert.equal(git(path, "rev-parse", "--is-inside-work-tree"), "true");
});

test("list reports the bootstrapped worktree as clean + detached", () => {
  const rows = listJson();
  const real = rows.filter((w) => !w.id.startsWith("pending-"));
  assert.ok(real.length >= 1, "expected at least one real worktree");
  const w = real[0];
  assert.equal(w.liveBranch, null, "fresh worktree should be detached");
  assert.ok(w.liveCommit, "fresh worktree should report a commit");
});

test("list surfaces a created branch from the live HEAD", () => {
  const w = listJson().find((x) => !x.id.startsWith("pending-"));
  git(w.path, "switch", "-c", "feature/x", "-q");
  writeFileSync(join(w.path, "new.txt"), "hi\n");

  // list reads the live branch via cheap plumbing (no git status / dirtiness).
  const after = listJson().find((x) => x.id === w.id);
  assert.equal(after.liveBranch, "feature/x");
});

test("list renders a ready (warm pool) worktree from state, no live git read", async () => {
  // The cold-start `up` triggers a background top-up that builds a warm,
  // never-handed-out `ready` worktree. Wait for one to appear.
  let ready;
  for (let i = 0; i < 50; i++) {
    ready = listJson().find((w) => w.status === "ready");
    if (ready) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(ready, "expected a ready worktree from the background top-up");

  // Rendered straight from state: detached on base.
  assert.equal(ready.liveBranch, null, "ready worktree should be detached");
  // The reported commit comes from the stored baseCommit (short form).
  assert.ok(ready.baseCommit, "ready worktree should have a stored baseCommit");
  assert.equal(ready.liveCommit, ready.baseCommit.slice(0, 11));
});

test("cold start records auto session info (no --meta passed)", () => {
  // The bootstrap `up` was run by execFileSync("node", ...), so the attaching
  // session is this test process — a real, live pid > 1.
  const w = listJson().find((x) => x.status === "attached");
  assert.ok(w, "expected an attached worktree");
  assert.ok(w.sessionInfo, "attached worktree should have sessionInfo");
  assert.equal(typeof w.sessionInfo.pid, "number");
  assert.ok(w.sessionInfo.pid > 1, "pid should be a real process id");
  assert.ok(w.sessionInfo.cwd, "sessionInfo should record a cwd");
  assert.equal(w.sessionMeta, null, "no --meta means sessionMeta is null");
});

test("ready (warm pool) worktrees carry no session info", async () => {
  let ready;
  for (let i = 0; i < 50; i++) {
    ready = listJson().find((w) => w.status === "ready");
    if (ready) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(ready, "expected a ready worktree from the background top-up");
  assert.equal(ready.sessionInfo, null);
  assert.equal(ready.sessionMeta, null);
});

test("up --meta stores caller metadata, surfaced in up + list --json", () => {
  const meta = { sessionId: "sess-abc", task: "luc/feature" };
  const r = wt(["up", repo, "--json", "--meta", JSON.stringify(meta)]);
  assert.equal(r.code, 0, `up --meta failed: ${r.stderr}`);
  const up = JSON.parse(r.stdout);
  assert.deepEqual(up.sessionMeta, meta, "up --json echoes sessionMeta");
  assert.ok(up.sessionInfo && typeof up.sessionInfo.pid === "number");

  // And it's queryable from list --json (how an agent finds its worktree).
  const listed = listJson().find(
    (w) => w.sessionMeta && w.sessionMeta.sessionId === "sess-abc",
  );
  assert.ok(listed, "should find the worktree by its sessionMeta");
  assert.equal(listed.id, up.id);

  // Release it so it doesn't interfere with later tests; meta clears on down.
  const down = wt(["down", up.id, "--force"]);
  assert.equal(down.code, 0, `down failed: ${down.stderr}`);
  const after = listJson().find((w) => w.id === up.id);
  if (after) {
    assert.equal(after.sessionMeta, null, "down clears sessionMeta");
    assert.equal(after.sessionInfo, null, "down clears sessionInfo");
  }
});

test("up --meta rejects non-object / invalid JSON before attaching", () => {
  const bad = wt(["up", repo, "--path-only", "--meta", "not json"]);
  assert.equal(bad.code, 1, "invalid JSON should fail");
  assert.match(bad.stderr, /--meta must be a JSON object/);

  const arr = wt(["up", repo, "--path-only", "--meta", "[1,2]"]);
  assert.equal(arr.code, 1, "a JSON array is not an object");
  assert.match(arr.stderr, /--meta must be a JSON object/);
});

/** Find the attached worktree we put on feature/x in an earlier test. */
function featureWorktree() {
  const w = listJson().find((x) => x.liveBranch === "feature/x");
  assert.ok(w, "expected the feature/x worktree from a previous test");
  return w;
}

test("down refuses a worktree with unsaved work, leaving state intact", () => {
  // The feature/x worktree still has an uncommitted new.txt from earlier.
  const w = featureWorktree();

  const r = wt(["down", w.id]);
  assert.equal(r.code, 1, "down should fail on unsaved work");
  assert.match(r.stderr, /refusing to release/);

  // Still present and still attached (unchanged).
  const still = listJson().find((x) => x.id === w.id);
  assert.ok(still, "worktree should still exist after refused down");
  assert.equal(still.status, "attached");
});

test("down --force releases it; the branch survives in the source repo", () => {
  const w = featureWorktree();
  // Commit so the branch ref persists after the worktree is reset.
  git(w.path, "add", "-A");
  git(w.path, "commit", "-qm", "work");

  const r = wt(["down", w.id, "--force"]);
  assert.equal(r.code, 0, `forced down failed: ${r.stderr}`);
  assert.match(r.stdout, /released/);

  // The branch ref still exists in the source repo (work recoverable).
  const branches = git(repo, "branch", "--list", "feature/x");
  assert.match(branches, /feature\/x/);
});

test("down with an unknown id errors clearly", () => {
  const r = wt(["down", "nope"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no worktree with id "nope"/);
});

test("build enables core.untrackedCache on the worktree", () => {
  const w = listJson().find((x) => !x.id.startsWith("pending-") && x.path);
  assert.ok(w, "expected at least one built worktree");
  const v = git(w.path, "config", "--get", "core.untrackedCache");
  assert.equal(v, "true", "build should enable core.untrackedCache");
});

test("build drops a Spotlight .metadata_never_index marker at the pool root", () => {
  // A worktree was built by the cold-start test above, so the marker that
  // buildWorktree() writes at the pool root must be present.
  const r = wt(["config", "--json"]);
  assert.equal(r.code, 0, `config --json failed: ${r.stderr}`);
  const { worktreeRoot } = JSON.parse(r.stdout).config;
  assert.ok(
    existsSync(join(worktreeRoot, ".metadata_never_index")),
    "expected .metadata_never_index at the worktree root after a build",
  );
});

test("--version matches package.json", () => {
  const pkg = execFileSync(
    "node",
    ["-e", "process.stdout.write(require('./package.json').version)"],
    { cwd: join(here, ".."), encoding: "utf8" },
  ).trim();
  const r = wt(["--version"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), pkg);
});

/** Resolve a configured repo's pool bounds via `wt config --json`. */
function repoConfig(source) {
  const r = wt(["config", "--json"]);
  assert.equal(r.code, 0, `config --json failed: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  return parsed.config.repos[source];
}

test("config sets the three pool knobs from new flags", () => {
  const r = wt([
    "config",
    repo,
    "--min-warm", "2",
    "--max-warm", "4",
    "--max-total", "12",
    "--yes",
  ]);
  assert.equal(r.code, 0, `config failed: ${r.stderr}`);
  const c = repoConfig(repo);
  assert.equal(c.minWarmPool, 2);
  assert.equal(c.maxWarmPool, 4);
  assert.equal(c.maxTotalPool, 12);
});

test("legacy --min/--max map to warm floor / total cap", () => {
  const r = wt(["config", repo, "--min", "3", "--max", "9", "--yes"]);
  assert.equal(r.code, 0, `config failed: ${r.stderr}`);
  const c = repoConfig(repo);
  assert.equal(c.minWarmPool, 3, "--min -> minWarmPool");
  assert.equal(c.maxTotalPool, 9, "--max -> maxTotalPool");
});

test("legacy poolSize in the config file resolves to a fixed-size pool", () => {
  // Write a raw legacy config and verify it loads with clamped bounds.
  const cfgFile = join(cfgDir, "config.jsonc");
  writeFileSync(
    cfgFile,
    JSON.stringify({ repos: { [repo]: { poolSize: 3 } } }, null, 2),
  );
  const c = repoConfig(repo);
  assert.equal(c.minWarmPool, 3);
  assert.equal(c.maxWarmPool, 3);
  assert.equal(c.maxTotalPool, 3);
});

test("bounds are clamped so minWarm <= maxWarm <= maxTotal", () => {
  const cfgFile = join(cfgDir, "config.jsonc");
  writeFileSync(
    cfgFile,
    JSON.stringify(
      { repos: { [repo]: { minWarmPool: 8, maxWarmPool: 2, maxTotalPool: 1 } } },
      null,
      2,
    ),
  );
  const c = repoConfig(repo);
  assert.equal(c.minWarmPool, 8);
  assert.equal(c.maxWarmPool, 8, "maxWarm raised to >= minWarm");
  assert.equal(c.maxTotalPool, 8, "maxTotal raised to >= maxWarm");
});
