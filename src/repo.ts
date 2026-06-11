import { createHash } from "node:crypto";
import { basename } from "node:path";
import { realpathSync } from "node:fs";
import { expandPath } from "./util.js";
import type { Config, RepoConfig } from "./config.js";

export interface ResolvedRepo {
  /** Absolute source path (the identity). */
  source: string;
  /** Stable filesystem/lock slug: <basename>-<sha4 of abs path>. */
  slug: string;
  /** Optional friendly alias, if configured. */
  name?: string;
  /** The matching config entry, or null if the repo isn't configured yet. */
  cfg: RepoConfig | null;
}

/** Does a token look like a filesystem path rather than an alias name? */
export function looksLikePath(token: string): boolean {
  return (
    token.includes("/") ||
    token.startsWith("~") ||
    token.startsWith(".") ||
    token.startsWith("$")
  );
}

/** First 4 hex chars of a sha1 of the absolute path. */
function sha4(absPath: string): string {
  return createHash("sha1").update(absPath).digest("hex").slice(0, 4);
}

/** Resolve symlinks when the path exists, else return the input. */
function realish(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Filesystem + lock slug for a repo, derived purely from its absolute source
 * path so it's stable and collision-proof: e.g. ~/code/acme-app -> "acme-app-3f9c".
 */
export function repoSlug(source: string): string {
  const abs = realish(expandPath(source));
  const base = basename(abs) || "repo";
  return `${base}-${sha4(abs)}`;
}

/**
 * Resolve a CLI token (a path or an alias name) to a repo identity.
 *
 * - A path-like token is expanded to an absolute path and used directly.
 * - Otherwise it's an alias: match a configured repo by `name`, then fall back
 *   to matching the source path's basename (erroring only on ambiguity).
 *
 * Returns the identity even for unconfigured paths (cfg = null) so callers can
 * offer to set the repo up.
 */
export function resolveRepo(config: Config, token: string): ResolvedRepo {
  if (looksLikePath(token)) {
    const source = realish(expandPath(token));
    const cfg = findBySource(config, source);
    return {
      source: cfg?.source ?? source,
      slug: repoSlug(cfg?.source ?? source),
      name: cfg?.name,
      cfg,
    };
  }

  // Alias: exact name match first.
  const byName = Object.values(config.repos).filter((r) => r.name === token);
  if (byName.length === 1) return toResolved(byName[0]);
  if (byName.length > 1) {
    throw new Error(`ambiguous alias "${token}" matches multiple repos by name`);
  }

  // Fallback: match by source basename.
  const byBase = Object.values(config.repos).filter(
    (r) => basename(r.source) === token,
  );
  if (byBase.length === 1) return toResolved(byBase[0]);
  if (byBase.length > 1) {
    throw new Error(
      `ambiguous repo "${token}" — multiple configured repos have that folder name; pass the full path`,
    );
  }

  const known = Object.values(config.repos)
    .map((r) => r.name ?? basename(r.source))
    .join(", ");
  throw new Error(
    `unknown repo "${token}". Pass a path (e.g. wt up ~/code/${token}) or use a configured alias.${
      known ? ` Known: ${known}` : ""
    }`,
  );
}

function toResolved(cfg: RepoConfig): ResolvedRepo {
  return { source: cfg.source, slug: repoSlug(cfg.source), name: cfg.name, cfg };
}

/** Find the configured source path for a given slug, if any. */
export function sourceForSlug(config: Config, slug: string): string | null {
  for (const r of Object.values(config.repos)) {
    if (repoSlug(r.source) === slug) return r.source;
  }
  return null;
}

function findBySource(config: Config, absSource: string): RepoConfig | null {
  for (const r of Object.values(config.repos)) {
    if (realish(r.source) === absSource) return r;
  }
  return null;
}
