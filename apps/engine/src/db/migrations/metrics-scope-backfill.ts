import { eq, isNull } from "drizzle-orm";
import { WILDCARD_SCOPE } from "../../auth/scopes.ts";
import { logger } from "../../logging/logger.ts";
import type { Db } from "../client.ts";
import {
  apiKeys,
  dataMigrations,
  roles as rolesTable,
  systemAccounts,
  users,
} from "../schema/index.ts";

export const METRICS_SCOPE_BACKFILL_NAME = "metrics_scope_grant_v1";

const METRICS_SCOPE = "metrics:read";
const ADMIN_ROLE = "admin";

export interface MetricsScopeBackfillReport {
  skipped: boolean;
  granted: number;
}

function scopeList(value: unknown): string[] | null {
  return Array.isArray(value) ? (value as string[]) : null;
}

export async function runMetricsScopeBackfill(db: Db): Promise<MetricsScopeBackfillReport> {
  const marker = await db
    .select({ name: dataMigrations.name })
    .from(dataMigrations) // tenant-filter:exempt — boot data-migration ledger; markers are instance-global by design
    .where(eq(dataMigrations.name, METRICS_SCOPE_BACKFILL_NAME))
    .limit(1);
  if (marker.length > 0) return { skipped: true, granted: 0 };

  const candidates = await db
    .select({
      id: apiKeys.id,
      tenant_id: apiKeys.tenant_id,
      scopes: apiKeys.scopes,
      user_id: apiKeys.user_id,
      user_role_name: rolesTable.name,
      system_account_id: apiKeys.system_account_id,
    })
    .from(apiKeys) // tenant-filter:exempt — cross-tenant one-shot upgrade repair
    .leftJoin(users, eq(users.id, apiKeys.user_id))
    .leftJoin(rolesTable, eq(rolesTable.id, users.role_id))
    .where(isNull(apiKeys.revoked_at));

  const accountRoles = new Map<string, string>();
  const accounts = await db
    .select({ id: systemAccounts.id, role_name: rolesTable.name })
    .from(systemAccounts) // tenant-filter:exempt — cross-tenant one-shot upgrade repair
    .leftJoin(rolesTable, eq(rolesTable.id, systemAccounts.role_id))
    .where(isNull(systemAccounts.deleted_at));
  for (const account of accounts) accountRoles.set(account.id, account.role_name ?? "member");

  const granted: string[] = [];
  for (const row of candidates) {
    const scopes = scopeList(row.scopes);

    if (scopes === null) continue;
    if (scopes.includes(METRICS_SCOPE)) continue;
    if (scopes.includes(WILDCARD_SCOPE)) continue;
    const role =
      row.user_id !== null
        ? row.user_role_name
        : row.system_account_id !== null
          ? (accountRoles.get(row.system_account_id) ?? "member")
          : null;
    if (role !== ADMIN_ROLE) continue;
    await db
      .update(apiKeys)
      .set({ scopes: [...scopes, METRICS_SCOPE] })
      .where(eq(apiKeys.id, row.id));
    granted.push(row.id);
  }

  await db
    .insert(dataMigrations)
    .values({ name: METRICS_SCOPE_BACKFILL_NAME })
    .onConflictDoNothing();

  logger.info({
    module: "db",
    action: "migrate.metrics_scope_backfill",
    msg: "granted metrics:read to scope-bearing admin API keys that reached /metrics before the scope gate",
    granted: granted.length,
    api_key_ids: granted,
  });
  return { skipped: false, granted: granted.length };
}
