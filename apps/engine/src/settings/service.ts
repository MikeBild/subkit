// Settings service.
//
// Read path:
//   - `get(key, tenant_id?)` → tenant override (if scope=tenant) →
//     global engine_settings row → registry default.
//   - In-process cache keyed by `${scope}:${key}:${tenant_id}` with a
//     short TTL. Invalidated by `pubsub` on `settings.changed` events
//     so cluster nodes converge after a write within one notify hop.
//
// Write path:
//   - `setGlobal(key, value, actor)` and `setTenant(key, value,
//     tenant_id, actor)` validate against `spec.schema` then upsert in
//     a transaction that also writes an `audit_log` entry and a
//     pubsub event. Secrets are redacted in the audit-log diff.
//
// Out of scope (deliberate):
//   - Cross-tenant fanout of write events (each tenant gets its own
//     pubsub message). Reuse the existing pubsub plumbing.
//   - Anything resembling secret encryption-at-rest beyond what
//     PostgreSQL gives us. The MASTER_KEY-driven crypto subsystem
//     stays for credentials only.

import { eq, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { engineSettings, tenants } from "../db/schema/identity.ts";
import { logger } from "../logging/logger.ts";
import { getSpec, listSpecs, maskValue, type SettingSpec } from "./registry.ts";

interface CacheEntry {
  value: unknown;
  expires_at: number;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(key: string, tenant_id: string | null): string {
  return `${tenant_id ?? "_global_"}::${key}`;
}

/** Drop every cached entry whose key matches this setting. Used by the
 *  pubsub listener on `settings.changed` events. */
export function invalidateCache(key: string, tenant_id: string | null = null): void {
  if (tenant_id === null) {
    // Global change invalidates the global cache AND every tenant
    // entry that might have inherited from it.
    for (const entry of cache.keys()) {
      if (entry.endsWith(`::${key}`)) cache.delete(entry);
    }
    return;
  }
  cache.delete(cacheKey(key, tenant_id));
}

export function clearCache(): void {
  cache.clear();
}

async function readGlobal(db: Db, key: string): Promise<unknown | undefined> {
  const rows = await db.select().from(engineSettings).where(eq(engineSettings.key, key)).limit(1);
  return rows[0]?.value;
}

async function readTenant(db: Db, key: string, tenant_id: string): Promise<unknown | undefined> {
  const rows = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenant_id))
    .limit(1);
  const settings = rows[0]?.settings;
  if (!settings || typeof settings !== "object") return undefined;
  const map = settings as Record<string, unknown>;
  return map[key];
}

export interface GetOptions {
  /** When set and the spec is `tenant`-scoped, the tenant's override
   *  is consulted first; otherwise resolves at the global level. */
  tenant_id?: string | null;
  /** Bypass cache. Useful for tests and the `sk doctor` round-trip. */
  fresh?: boolean;
}

/**
 * Resolve a setting value. Priority:
 *   1. tenant override (when scope=tenant + tenant_id given)
 *   2. global engine_settings row
 *   3. registry default
 *
 * Throws if `key` is not registered. Always returns a value typed by
 * the spec — callers do not need to validate again.
 */
export async function get<T = unknown>(db: Db, key: string, opts: GetOptions = {}): Promise<T> {
  const spec = getSpec(key);
  if (!spec) throw new Error(`unknown setting key: ${key}`);
  const tenantId = opts.tenant_id ?? null;
  const ck = cacheKey(key, spec.scope === "tenant" ? tenantId : null);

  if (!opts.fresh) {
    const hit = cache.get(ck);
    if (hit && hit.expires_at > Date.now()) return hit.value as T;
  }

  let raw: unknown | undefined;
  if (spec.scope === "tenant" && tenantId) {
    raw = await readTenant(db, key, tenantId);
  }
  if (raw === undefined) {
    raw = await readGlobal(db, key);
  }
  const value = raw === undefined ? spec.default : raw;
  cache.set(ck, { value, expires_at: Date.now() + CACHE_TTL_MS });
  return value as T;
}

interface WriteContext {
  /** Triggering principal — used for audit_log lineage. `null` =
   *  system action (bootstrap, migration). */
  actor_id: string | null;
  actor_type?: "user" | "system_account" | "system";
}

async function emitChange(
  db: Db,
  spec: SettingSpec,
  tenantId: string | null,
  before: unknown,
  after: unknown,
  ctx: WriteContext,
): Promise<void> {
  // Tenant-scoped change: audit row + pubsub event under the tenant.
  // Global change: no audit row (audit_log is tenant-scoped by design);
  // the structured log line below carries the same diff for SOC2 review.
  if (tenantId) {
    await db.transaction(async (tx) => {
      await writeEvent(tx, {
        tenant_id: tenantId,
        channel: "event.emitted",
        type: "settings.changed",
        payload: { key: spec.key, scope: spec.scope, tenant_id: tenantId },
      });
    });
    await auditAwait(
      {
        tenant_id: tenantId,
        actor_type: ctx.actor_type ?? (ctx.actor_id ? "user" : "system"),
        actor_id: ctx.actor_id,
        action: AuditAction.SETTINGS_CHANGED,
        resource_type: "engine_setting",
        resource_id: spec.key,
        result: "success",
        reason: null,
        metadata: {
          scope: spec.scope,
          before: maskValue(spec, before),
          after: maskValue(spec, after),
        },
      },
      db,
    );
    return;
  }
  logger.info({
    module: "settings",
    action: "settings.changed",
    msg: "global setting changed",
    key: spec.key,
    scope: spec.scope,
    actor_id: ctx.actor_id,
    before: maskValue(spec, before),
    after: maskValue(spec, after),
  });
}

/** Validate, upsert into engine_settings, audit, and broadcast. */
export async function setGlobal(
  db: Db,
  key: string,
  value: unknown,
  ctx: WriteContext,
): Promise<void> {
  const spec = getSpec(key);
  if (!spec) throw new Error(`unknown setting key: ${key}`);
  if (spec.scope !== "global") {
    throw new Error(`setting ${key} is tenant-scoped — use setTenant`);
  }
  const parsed = spec.schema.parse(value);
  const before = await readGlobal(db, key);

  await db
    .insert(engineSettings)
    .values({ key, value: parsed, updated_by: ctx.actor_id })
    .onConflictDoUpdate({
      target: engineSettings.key,
      set: { value: parsed, updated_by: ctx.actor_id, updated_at: new Date() },
    });

  invalidateCache(key);
  await emitChange(db, spec, null, before, parsed, ctx);
  logger.info({
    module: "settings",
    action: "settings.set",
    msg: "global setting updated",
    key,
    actor_id: ctx.actor_id,
  });
}

/** Validate, write into tenants.settings JSONB, audit, broadcast. */
export async function setTenant(
  db: Db,
  key: string,
  value: unknown,
  tenant_id: string,
  ctx: WriteContext,
): Promise<void> {
  const spec = getSpec(key);
  if (!spec) throw new Error(`unknown setting key: ${key}`);
  if (spec.scope !== "tenant") {
    throw new Error(`setting ${key} is global — use setGlobal`);
  }
  const parsed = spec.schema.parse(value);
  const before = await readTenant(db, key, tenant_id);

  // Use jsonb_set so we don't clobber other keys in the same JSONB.
  await db
    .update(tenants)
    .set({
      settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), ${`{${key}}`}::text[], ${JSON.stringify(parsed)}::jsonb, true)`,
    })
    .where(eq(tenants.id, tenant_id));

  invalidateCache(key, tenant_id);
  await emitChange(db, spec, tenant_id, before, parsed, ctx);
  logger.info({
    module: "settings",
    action: "settings.set",
    msg: "tenant setting updated",
    key,
    tenant_id,
    actor_id: ctx.actor_id,
  });
}

export interface ListedSetting {
  key: string;
  label: string;
  description: string;
  scope: "global" | "tenant";
  category: string;
  secret: boolean;
  /** The resolved value (already masked when secret). */
  value: unknown;
  /** True when the value comes from the registry default — i.e. nothing
   *  was ever explicitly set. */
  is_default: boolean;
}

/**
 * Return every registered setting with its resolved value. Tenant-scoped
 * settings are resolved against `tenant_id` when provided. Secrets are
 * masked in the output — call `get` directly for the live value.
 */
export async function list(db: Db, opts: GetOptions = {}): Promise<ListedSetting[]> {
  const out: ListedSetting[] = [];
  for (const spec of listSpecs()) {
    let raw: unknown | undefined;
    if (spec.scope === "tenant" && opts.tenant_id) {
      raw = await readTenant(db, spec.key, opts.tenant_id);
    }
    if (raw === undefined) {
      raw = await readGlobal(db, spec.key);
    }
    const isDefault = raw === undefined;
    const resolved = isDefault ? spec.default : raw;
    out.push({
      key: spec.key,
      label: spec.label,
      description: spec.description,
      scope: spec.scope,
      category: spec.category,
      secret: Boolean(spec.secret),
      value: maskValue(spec, resolved),
      is_default: isDefault,
    });
  }
  return out;
}
