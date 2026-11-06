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

const PERSISTED_SNAPSHOT_VERSION = 3 as const;

export function fingerprintApiKey(apiKey: string | undefined): string {
  return createHash("sha256")
    .update(apiKey ?? "")
    .digest("hex")
    .slice(0, 16);
}

function bootstrapCacheKey(profile: ResolvedProfile): {
  engineSlug: string;
  tenantSlug: string;
  tokenFp: string;
} {
  const tenantSlug =
    profile.active_tenant_id == null
      ? "__no_tenant__"
      : profile.active_tenant_id.replace(/[^a-z0-9_-]/gi, "_");
  const hostPrefix = profile.engine_url.replace(/[^a-z0-9_-]/gi, "_").slice(0, 24) || "engine";
  const urlFp = createHash("sha256").update(profile.engine_url).digest("hex").slice(0, 12);
  const engineSlug = `${hostPrefix}-${urlFp}`;
  const tokenFp = fingerprintApiKey(profile.api_key);
  return { engineSlug, tenantSlug, tokenFp };
}

export type SkBootstrapWireResponse = components["schemas"]["SkBootstrap"];
export type SkBootstrapFlags = SkBootstrapWireResponse["flags"];

const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface SkBootstrapSnapshot {
  label: string;
  allowed: Set<string>;
  probe: PersonaProbe;
  tenant: string | null;
  email: string | null;
  recentSessions: SkBootstrapWireResponse["recent_sessions"];
  flags: SkBootstrapFlags;
  prefs: SkBootstrapWireResponse["prefs"];
  fetchedAt: number;
  source: "network" | "cache" | "fallback";
}

export interface BootstrapOptions {
  cacheDir?: string;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
  now?: () => number;
}

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
    flags: z.record(z.string(), z.boolean()),
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
    flags: filterFlagsToKnown(p.flags),
    prefs: p.prefs as SkBootstrapWireResponse["prefs"],
    fetchedAt: p.fetched_at,
    source,
  };
}

const DEFAULT_SK_PREFS: SkBootstrapWireResponse["prefs"] = {
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
    debugLog("bootstrap.cache_write_failed", { path, error: serializeDebugError(err) }, {});
  }
}
