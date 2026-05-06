// Single-call CLI bootstrap with disk cache + tiered fallback.
//
// New engines (>= the Checkpoint-0 release) expose `GET /v1/sk/bootstrap`
// which returns the authenticated principal's UX-gating permission
// allow-set in one call. Older engines don't, so we fall back to the
// tiered `whoami + rbac:can` probing in `persona-probe.ts`.
//
// A small disk cache at `~/.sk/cache/persona-{tenant}-{user}.json` lets
// subsequent CLI launches skip the network entirely for `cacheTtlMs`,
// returning the snapshot synchronously while a background revalidate
// refreshes the cache. The engine still enforces RBAC on every
// individual call — this cache only gates *which slash commands appear
// in the help menu*. Stale cache → at worst an unavailable command
// looks visible until the next bootstrap; never the other way around.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ResolvedProfile } from "../config.ts";
import type { EngineClient } from "../engine-client.ts";
import { type ResolvedPersonaSnapshot, resolvePersonaShared } from "../persona-probe.ts";
import type { PersonaProbe } from "../slash.ts";

const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

export interface SkBootstrapSnapshot {
  /** Persona label — admin/operator/member/portal/enduser/user. Used for slash-menu gating. */
  label: string;
  /** Allowed permissions as a Set for O(1) lookup. */
  allowed: Set<string>;
  /** Probe object compatible with the existing slash registry. */
  probe: PersonaProbe;
  /** Tenant slug or uuid. Surfaced in the status line. */
  tenant: string | null;
  /** User email or sub. Surfaced in the status line. */
  email: string | null;
  /** Recent conversations the principal owns; empty for new users. */
  recentSessions: Array<{ id: string; title: string | null; updated_at: string }>;
  /** Persona-visible feature flags. Empty until the engine populates them. */
  flags: Record<string, boolean>;
  /** Wall-clock time the snapshot was produced (ms since epoch). */
  fetchedAt: number;
  /** Whether the snapshot came from the network or from disk cache. */
  source: "network" | "cache" | "fallback";
}

export interface BootstrapOptions {
  /** Override the disk-cache directory (defaults to `~/.sk/cache`). */
  cacheDir?: string;
  /** TTL for the disk cache. Set to 0 to disable. */
  cacheTtlMs?: number;
  /** When true, skip the cache read entirely. */
  forceRefresh?: boolean;
  /** Override clock for tests. */
  now?: () => number;
}

interface PersistedSnapshot {
  v: 1;
  label: string;
  allowed: string[];
  tenant: string | null;
  email: string | null;
  recent_sessions: Array<{ id: string; title: string | null; updated_at: string }>;
  flags: Record<string, boolean>;
  fetched_at: number;
}

/**
 * Resolve the bootstrap snapshot for the active profile. Tries:
 *   1. disk cache (if not `forceRefresh` and not stale)
 *   2. `GET /v1/sk/bootstrap`
 *   3. tiered `resolvePersonaShared` fallback (older engines)
 *
 * Always resolves — never throws — so the REPL can render even if
 * every path fails (in which case the persona collapses to "user" with
 * an empty allow-set, matching the legacy behavior).
 */
export async function loadBootstrap(
  client: EngineClient,
  profile: ResolvedProfile,
  opts: BootstrapOptions = {},
): Promise<SkBootstrapSnapshot> {
  const ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = opts.now ?? Date.now;
  const cachePath = bootstrapCachePath(profile, opts.cacheDir);

  if (!opts.forceRefresh && ttl > 0) {
    const cached = readCachedSnapshot(cachePath);
    if (cached && now() - cached.fetched_at < ttl) {
      return materialize(cached, "cache");
    }
  }

  // Try the new endpoint first.
  try {
    const resp = await client.skBootstrap();
    const persisted: PersistedSnapshot = {
      v: 1,
      label: resp.whoami.role_name ?? profile.persona_hint ?? "user",
      allowed: resp.permissions,
      tenant: resp.whoami.tenant_slug ?? resp.whoami.tenant_id ?? null,
      email: resp.whoami.email,
      recent_sessions: resp.recent_sessions,
      flags: resp.flags,
      fetched_at: now(),
    };
    writeCachedSnapshot(cachePath, persisted);
    return materialize(persisted, "network");
  } catch (err) {
    // 404 means "older engine without the endpoint". Anything else
    // (auth, network, 500) — also fall through to the legacy probe so
    // the REPL still gets *some* persona to gate on. The legacy probe
    // has its own try/catch and returns a conservative default.
    void err;
  }

  // Fallback: tiered persona-probe.
  const fallback = await resolvePersonaShared(client, profile);
  return fromLegacy(fallback, now());
}

function materialize(
  p: PersistedSnapshot,
  source: SkBootstrapSnapshot["source"],
): SkBootstrapSnapshot {
  const allowed = new Set(p.allowed);
  return {
    label: p.label,
    allowed,
    probe: { allows: (perm: string) => allowed.has(perm) },
    tenant: p.tenant,
    email: p.email,
    recentSessions: p.recent_sessions,
    flags: p.flags,
    fetchedAt: p.fetched_at,
    source,
  };
}

function fromLegacy(snap: ResolvedPersonaSnapshot, fetchedAt: number): SkBootstrapSnapshot {
  return {
    label: snap.label,
    allowed: snap.allowed,
    probe: snap.probe,
    tenant: snap.tenant,
    email: snap.email,
    recentSessions: [],
    flags: {},
    fetchedAt,
    source: "fallback",
  };
}

export function bootstrapCachePath(profile: ResolvedProfile, override?: string): string {
  const dir = override ?? join(homedir(), ".sk", "cache");
  // Profile is keyed by engine_url + tenant + api_key in config; using
  // `tenant_id`-or-`engine_url` keeps the cache file scoped per-(engine, tenant).
  // Empty tenant is allowed — admins commonly run without an active tenant.
  const tenantSlug = (profile.active_tenant_id ?? "global").replace(/[^a-z0-9_-]/gi, "_");
  const engineSlug = profile.engine_url.replace(/[^a-z0-9_-]/gi, "_").slice(-32) || "engine";
  return join(dir, `bootstrap-${engineSlug}-${tenantSlug}.json`);
}

function readCachedSnapshot(path: string): PersistedSnapshot | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as PersistedSnapshot;
    if (parsed.v !== 1 || !Array.isArray(parsed.allowed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedSnapshot(path: string, snap: PersistedSnapshot): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(snap), { mode: 0o600 });
  } catch {
    // Cache writes are best-effort. If the disk is full or read-only
    // we fall back to in-memory only — the REPL still works.
  }
}

/** Test-only: drop a cached snapshot for a profile. */
export function _clearBootstrapCacheForTests(profile: ResolvedProfile, cacheDir?: string): void {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.unlinkSync(bootstrapCachePath(profile, cacheDir));
  } catch {
    /* fine — already gone */
  }
}
