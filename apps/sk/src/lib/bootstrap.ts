// Single-call CLI bootstrap with disk cache.
//
// `GET /v1/sk/bootstrap` returns the authenticated principal's UX-gating
// permission allow-set in one call.
//
// A small disk cache at `~/.sk/cache/persona-{tenant}-{user}.json` lets
// subsequent CLI launches skip the network entirely for `cacheTtlMs`,
// returning the snapshot synchronously while a background revalidate
// refreshes the cache. The engine still enforces RBAC on every
// individual call — this cache only gates *which slash commands appear
// in the help menu*. Stale cache → at worst an unavailable command
// looks visible until the next bootstrap; never the other way around.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { z } from "zod";
import type { ResolvedProfile } from "../config.ts";
import { debugLog, serializeDebugError } from "../debug.ts";
import type { EngineClient } from "../engine-client.ts";
import type { PersonaProbe } from "../slash.ts";

/** Persisted-snapshot schema version. Bump on any field-shape
 *  change; readers reject mismatched versions. Current version
 *  reflects `prefs.portalTokenTtlMin` being part of the wire shape;
 *  older caches lack the field and `.strict()` rejects them on read
 *  so the next bootstrap re-fetches with the new shape. */
export const PERSISTED_SNAPSHOT_VERSION = 3 as const;

/** Derive a stable, sha256-fingerprinted cache key from a
 *  profile. Used by both `bootstrapCachePath` and the React
 *  `usePersona` hook so they can never disagree on what counts as
 *  "the same principal". */
export function fingerprintApiKey(apiKey: string | undefined): string {
  return createHash("sha256")
    .update(apiKey ?? "")
    .digest("hex")
    .slice(0, 16);
}

export function bootstrapCacheKey(profile: ResolvedProfile): {
  engineSlug: string;
  tenantSlug: string;
  tokenFp: string;
} {
  // The no-tenant sentinel cannot collide with
  // any sanitised real tenant slug. The sanitiser keeps `[A-Za-z0-9_-]`
  // and replaces everything else with `_`, so any sentinel that
  // contains the `__` substring (which a tenant slug pattern
  // `^[a-z0-9-]+$` cannot produce) is collision-free.
  const tenantSlug =
    profile.active_tenant_id == null
      ? "__no_tenant__"
      : profile.active_tenant_id.replace(/[^a-z0-9_-]/gi, "_");
  // engineSlug = `<host-prefix-24>-<sha256(full url)[0..12]>`
  //
  // Keeps the cache filename grep-friendly via the
  // host-prefix while making accidental collisions implausible via
  // the URL hash. The previous shape — `engine_url.slice(-32)` —
  // collapsed `engine-old.acme.example/` and `engine-new.acme.example/`
  // to the same key. Do NOT simplify back to a substring of the URL;
  // the hash is load-bearing for the host-prefix-collision case.
  // Hash size: 12 hex (~1 in 2^48 per pair), negligible at one
  // operator's profile-rotation scale.
  const hostPrefix = profile.engine_url.replace(/[^a-z0-9_-]/gi, "_").slice(0, 24) || "engine";
  const urlFp = createHash("sha256").update(profile.engine_url).digest("hex").slice(0, 12);
  const engineSlug = `${hostPrefix}-${urlFp}`;
  const tokenFp = fingerprintApiKey(profile.api_key);
  return { engineSlug, tenantSlug, tokenFp };
}

/** Wire-shape pulled directly from the generated OpenAPI client.
 *  Used by both the consumer types below and `engine-client.ts` so
 *  a typo in a flag name fails to compile across the whole CLI. */
export type SkBootstrapWireResponse = components["schemas"]["SkBootstrap"];
export type SkBootstrapFlags = SkBootstrapWireResponse["flags"];

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
  recentSessions: SkBootstrapWireResponse["recent_sessions"];
  /** Persona-visible feature flags. Drawn from the generated openapi
   *  type so a typo on either the engine or CLI side fails to
   *  compile. */
  flags: SkBootstrapFlags;
  /** REPL + UI + notification preferences resolved by the engine for
   *  this principal. */
  prefs: SkBootstrapWireResponse["prefs"];
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

// Zod schema for the persisted cache file. Reads validate
// the parsed JSON against this schema and reject the file on
// mismatch — a corrupted file or stale field shape now fails
// closed instead of flowing into `materialize()`. The cache file
// is `0o600` and per-user, so this isn't a tenant boundary, but it
// is a CLI input boundary per AGENTS.md "Zod at every CLI input".
const PersistedSnapshotSchema = z
  .object({
    v: z.literal(PERSISTED_SNAPSHOT_VERSION),
    label: z.string(),
    allowed: z.array(z.string()),
    tenant: z.string().nullable(),
    email: z.string().nullable(),
    recent_sessions: z.array(
      z.object({
        id: z.string(),
        title: z.string().nullable(),
        updated_at: z.string(),
        tenant_id: z.string(),
      }),
    ),
    // `flags` is the typed enum object from the engine — empty `{}`
    // today. The wire shape strictly rejects unknown keys
    // (engine-side); the cache reader is more permissive (passthrough
    // record) so a snapshot produced by a newer engine with new
    // flags doesn't fail to read on an older CLI. The engine-side
    // strict() is the contract; this is the cache-replay path. The
    // cast at the materialize() boundary closes the type gap when
    // `SkBootstrapFlags` is the empty object.
    //
    // When the first real flag lands engine-side, also bump
    // `PERSISTED_SNAPSHOT_VERSION` so older malformed cache files
    // (which would have any boolean key whatsoever under this
    // permissive record) get rejected on the next read instead of
    // smuggling an off-enum boolean into runtime. The version bump
    // is the migration boundary; the wire schema is the source of
    // truth for the new shape.
    flags: z.record(z.string(), z.boolean()),
    // `prefs` carries REPL + UI + notification settings resolved by
    // the engine. Schema is `.strict()`: the surrounding contract
    // pins shape via `PERSISTED_SNAPSHOT_VERSION`, so a new
    // engine-side prefs field requires a version bump anyway, and
    // strict rejection on the cache reader is the same fail-closed
    // posture every other persisted-shape leaf has. Allowing unknown
    // keys here would silently smuggle a stale-cache field through to
    // `materialize()` after a downgrade, exactly the failure mode
    // PERSISTED_SNAPSHOT_VERSION exists to prevent.
    prefs: z
      .object({
        permissionMode: z.enum(["ask", "auto", "plan", "yolo"]),
        theme: z.enum(["auto", "light", "dark", "high-contrast"]),
        personality: z.enum(["concise", "balanced", "verbose"]),
        titleFormat: z.enum(["session-id", "tenant-session", "model-tenant-session"]),
        statuslineFormat: z.enum(["minimal", "compact", "detailed"]),
        pushNotifyEnabled: z.boolean(),
        pushNotifyThresholdSec: z.number().int().positive(),
        quietHoursStart: z.string(),
        quietHoursEnd: z.string(),
        portalTokenTtlMin: z.number().int().positive(),
      })
      .strict(),
    fetched_at: z.number().int().nonnegative(),
  })
  .strict();

type PersistedSnapshot = z.infer<typeof PersistedSnapshotSchema>;

/** Closed allow-list of flag keys the cache reader will
 *  surface. Today empty (mirrors `SkBootstrapFlagsSchema = z.object({}).strict()`).
 *  When the first real flag lands engine-side, add its name here
 *  AND bump `PERSISTED_SNAPSHOT_VERSION` so older malformed caches
 *  don't smuggle an off-enum boolean into runtime. The
 *  typecheck-time pin at `_FLAG_KEYS_PIN` ensures this list stays
 *  in lockstep with the typed `SkBootstrapFlags` object. */
const KNOWN_FLAG_KEYS: ReadonlySet<string> = new Set<keyof SkBootstrapFlags>([]);
type _FlagKeysPin = readonly (keyof SkBootstrapFlags)[];
const _FLAG_KEYS_PIN: _FlagKeysPin = [...KNOWN_FLAG_KEYS] as _FlagKeysPin;
void _FLAG_KEYS_PIN;

function filterFlagsToKnown(rawFlags: Record<string, boolean>): SkBootstrapFlags {
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(rawFlags)) {
    if (KNOWN_FLAG_KEYS.has(k)) out[k] = v;
  }
  return out as unknown as SkBootstrapFlags;
}

/**
 * Resolve the bootstrap snapshot for the active profile. Tries:
 *   1. disk cache (if not `forceRefresh` and not stale)
 *   2. `GET /v1/sk/bootstrap`
 *
 * Always resolves — never throws — so the REPL can render even if
 * every path fails (in which case the persona collapses to the profile
 * hint with an empty allow-set).
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

  try {
    const resp = await client.skBootstrap();
    const persisted: PersistedSnapshot = {
      v: PERSISTED_SNAPSHOT_VERSION,
      label: resp.whoami.role_name ?? profile.persona_hint ?? "user",
      allowed: resp.permissions,
      tenant: resp.whoami.tenant_slug ?? resp.whoami.tenant_id ?? null,
      email: resp.whoami.email,
      recent_sessions: resp.recent_sessions,
      flags: resp.flags,
      prefs: resp.prefs,
      fetched_at: now(),
    };
    writeCachedSnapshot(cachePath, persisted);
    return materialize(persisted, "network");
  } catch (err) {
    debugLog(
      "bootstrap.fetch_failed",
      {
        engine_url: profile.engine_url,
        tenant: profile.active_tenant_id,
        error: serializeDebugError(err),
      },
      {},
    );
  }

  return unresolvedSnapshot(profile, now());
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
    // Cache schema accepts arbitrary `flags` keys
    // but the engine-side wire schema is strict (`.object({}).strict()`
    // today, will narrow as flags land). Drop any key that isn't on
    // the wire-shape's allowed set so a tampered cache file can't
    // smuggle an off-enum boolean into the persona-aware UI. The
    // wire-shape is the empty object today; future flag additions
    // mean updating `KNOWN_FLAG_KEYS` below alongside the engine
    // schema (the typecheck-time invariant in `_FLAG_KEYS_PIN`
    // catches drift).
    flags: filterFlagsToKnown(p.flags),
    prefs: p.prefs as SkBootstrapWireResponse["prefs"],
    fetchedAt: p.fetched_at,
    source,
  };
}

/** CLI-side pref defaults, used whenever the engine cannot supply prefs
 *  (unreachable engine, failed bootstrap, profile switch). Stay conservative when no current server policy is known;
 *  a reachable new engine supplies its autonomous-preparation default. */
export const DEFAULT_SK_PREFS: SkBootstrapWireResponse["prefs"] = {
  permissionMode: "ask",
  theme: "auto",
  personality: "balanced",
  titleFormat: "session-id",
  statuslineFormat: "compact",
  pushNotifyEnabled: false,
  pushNotifyThresholdSec: 30,
  quietHoursStart: "",
  quietHoursEnd: "",
  portalTokenTtlMin: 15,
};

/** Snapshot keyed off the profile alone, for when the engine cannot
 *  answer the bootstrap. Grants nothing; the engine gates every call. */
export function unresolvedSnapshot(
  profile: ResolvedProfile,
  fetchedAt: number,
): SkBootstrapSnapshot {
  return {
    label: profile.persona_hint ?? "user",
    allowed: new Set(),
    probe: { allows: () => false },
    tenant: profile.active_tenant_id ?? null,
    email: null,
    recentSessions: [],
    flags: {},
    prefs: DEFAULT_SK_PREFS,
    fetchedAt,
    source: "fallback",
  };
}

export function bootstrapCachePath(profile: ResolvedProfile, override?: string): string {
  const dir = override ?? join(homedir(), ".sk", "cache");
  // The cache file is scoped per (engine, tenant, api_key). Earlier
  // versions only keyed on (engine, tenant), which meant overriding
  // SUBKIT_API_KEY on the same profile (e.g. `admin runs as themselves
  // → admin runs as a portal token to repro a bug`) would replay the
  // previous principal's permission set against the new bearer.
  //
  // The fingerprint is the first 16 hex chars of sha256(api_key) —
  // short enough to keep the filename readable, long enough to make a
  // cross-token collision negligible (~1 in 2^64). 8 hex was
  // 1-in-2^32 per pair, which is fine for two keys
  // but starts approaching birthday-bound territory across an
  // operator's lifetime of rotated tokens, so the width is 16. The
  // hash itself is never reversible to the bearer because we only
  // persist the prefix.
  // Derive the (engine, tenant, fingerprint) triple from the
  // shared helper so this path and `usePersona`'s `bootstrapKey` can
  // never disagree on what counts as the same principal.
  const { engineSlug, tenantSlug, tokenFp } = bootstrapCacheKey(profile);
  return join(dir, `bootstrap-${engineSlug}-${tenantSlug}-${tokenFp}.json`);
}

function readCachedSnapshot(path: string): PersistedSnapshot | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // Strict Zod validation. A corrupted file, version
  // mismatch, or unknown extra field now fails closed.
  const result = PersistedSnapshotSchema.safeParse(parsed);
  if (!result.success) {
    debugLog("bootstrap.cache_read_rejected", { path, error: result.error.message }, {});
    return null;
  }
  return result.data;
}

function writeCachedSnapshot(path: string, snap: PersistedSnapshot): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(snap), { mode: 0o600 });
  } catch (err) {
    // Cache writes are best-effort. If the disk is full or read-only
    // we fall back to in-memory only — the REPL still works.
    // Surface the failure via debugLog so a CI runner with a
    // read-only `~/.sk/cache` (or similar) doesn't silently disable
    // caching forever.
    debugLog("bootstrap.cache_write_failed", { path, error: serializeDebugError(err) }, {});
  }
}
