// ~/.sk/sessions/*.json session metadata cache.
//
// The cache exists so `sk -c` (continue most recent) can find the
// last conversation id without round-tripping to the engine. Each
// entry is one small JSON file per session containing the engine
// URL, tenant id, conversation id, title, model, and a `last_used_at`
// timestamp that drives "most recent" ordering.
//
// The engine remains source of truth — these files are a local hint
// and are safe to delete at any time. `sk` never stores message
// content here; the audit trail lives server-side.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionMetadata {
  conversation_id: string;
  engine_url: string;
  tenant_id: string | null;
  title: string | null;
  model: string | null;
  created_at: string;
  last_used_at: string;
  /** Short human-readable alias set via `sk rename`. Unique per
   *  profile when present; used by `sk -r <alias>` as an alternative
   *  to the full conversation_id. Optional (older sessions predate
   *  this field). */
  alias?: string | null;
}

/** Resolve a session-id-or-alias lookup. Returns the matching metadata
 *  or null when no match exists. Exact conversation_id wins over alias
 *  match; prefix matching is explicitly NOT supported to keep the
 *  resolution deterministic.
 *
 *  Filter applies the same profile scoping as `listSessionMetadata`
 *  so `sk rm foo` in one profile can't accidentally nuke a same-named
 *  session from another. */
export function resolveSessionRef(
  ref: string,
  filter?: { engine_url?: string; tenant_id?: string | null },
): SessionMetadata | null {
  const direct = loadSessionMetadata(ref);
  if (direct) {
    if (filter?.engine_url && direct.engine_url !== filter.engine_url) return null;
    if (filter?.tenant_id !== undefined && direct.tenant_id !== filter.tenant_id) {
      return null;
    }
    return direct;
  }
  for (const meta of listSessionMetadata(filter)) {
    if (meta.alias === ref) return meta;
  }
  return null;
}

/**
 * Resolve the on-disk cache directory. Honors `SK_HOME` so tests can
 * redirect the cache to a scratch dir without touching the user's real
 * `~/.sk` folder. Falls back to `~/.sk/sessions` for normal usage.
 */
export function sessionsDir(): string {
  const override = process.env.SK_HOME;
  if (override && override.length > 0) {
    return join(override, "sessions");
  }
  return join(homedir(), ".sk", "sessions");
}

export function sessionPath(conversation_id: string): string {
  return join(sessionsDir(), `${conversation_id}.json`);
}

function ensureDir(): void {
  const dir = sessionsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* non-unix: no-op */
    }
  }
}

export function saveSessionMetadata(meta: SessionMetadata): void {
  ensureDir();
  const path = sessionPath(meta.conversation_id);
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

export function loadSessionMetadata(conversation_id: string): SessionMetadata | null {
  const path = sessionPath(conversation_id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SessionMetadata;
  } catch {
    return null;
  }
}

/**
 * Return all locally-cached sessions, newest first by `last_used_at`.
 * Optionally filter to a specific engine URL + tenant so a user with
 * multiple profiles doesn't accidentally reattach across environments.
 */
export function listSessionMetadata(filter?: {
  engine_url?: string;
  tenant_id?: string | null;
}): SessionMetadata[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const entries: SessionMetadata[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      const meta = JSON.parse(readFileSync(full, "utf8")) as SessionMetadata;
      if (filter?.engine_url && meta.engine_url !== filter.engine_url) continue;
      if (filter?.tenant_id !== undefined && meta.tenant_id !== filter.tenant_id) continue;
      entries.push(meta);
    } catch {
      /* skip malformed rows */
    }
  }
  entries.sort((a, b) => (a.last_used_at < b.last_used_at ? 1 : -1));
  return entries;
}

/**
 * Resolve the "continue most recent" convention: newest cached session
 * matching the active profile. Used by `sk -c` at the top level.
 */
export function mostRecentSession(filter: {
  engine_url: string;
  tenant_id: string | null;
}): SessionMetadata | null {
  const all = listSessionMetadata(filter);
  return all[0] ?? null;
}
