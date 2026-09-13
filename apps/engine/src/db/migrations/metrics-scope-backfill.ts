// One-shot code backfill: keep the keys that scrape `/metrics` today working.
//
// `GET /metrics` now requires the `metrics:read` scope from every credential
// that carries a scope list; the owner's role no longer widens a scope grant
// (`http/middleware/scope.ts`). Before that change a scope-bearing key reached
// `/metrics` iff its owner held the `admin` role — the scope list was ignored.
//
// Exactly those rows are what this backfill repairs: a live `api_keys` row
// that names a NARROW scope list (no `*` wildcard — a wildcard key asserts no
// narrowing and still reaches `/metrics` through the role check), does NOT
// already contain `metrics:read`, and belongs to an admin owner. Adding the
// scope reproduces its previous answer on `/metrics` and changes nothing
// else, because `metrics:read` gates that one route. A production Prometheus
// scraper or deploy verify that used such a key keeps working across the
// upgrade instead of turning 403 at rollout.
//
// Deliberately NOT repaired: connection tokens (`mcp_oauth_access_tokens`).
// A delegated token that says `mcp:read` must mean `mcp:read` — that a
// connection approved for MCP read could scrape `/metrics` is the defect this
// release fixes, not state to preserve.
//
// Idempotent through a `data_migrations` marker; a failure leaves the marker
// unset so the next boot retries. Never breaks boot — the caller wraps it.

import { eq, isNull } from "drizzle-orm";

import { WILDCARD_SCOPE } from "../../auth/scopes.ts";
import { resolveEffectiveUserRole } from "../../auth/user-role.ts";
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

  // Every live, scope-bearing key with its owner's effective role. The join is
  // the same owner resolution `providers/api-key-row.ts` performs at auth time
  // (custom role name wins over the legacy enum column), so the predicate here
  // and the gate there see the same role.
  const candidates = await db
    .select({
      id: apiKeys.id,
      tenant_id: apiKeys.tenant_id,
      scopes: apiKeys.scopes,
      user_role: users.role,
      user_role_name: rolesTable.name,
      system_account_id: apiKeys.system_account_id,
    })
    .from(apiKeys) // tenant-filter:exempt — cross-tenant one-shot upgrade repair
    .leftJoin(users, eq(users.id, apiKeys.user_id))
    .leftJoin(rolesTable, eq(rolesTable.id, users.role_id))
    .where(isNull(apiKeys.revoked_at));

  // System-account keys resolve their role through a second roles lookup;
  // read it separately rather than joining `roles` twice in one statement.
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
    // No scope list at all → unrestricted credential → still reaches
    // `/metrics` through the role check. Nothing to repair.

    if (scopes === null) continue;
    if (scopes.includes(METRICS_SCOPE)) continue;
    // `*` asserts no narrowing — the gate still falls back to the role check
    // for it, so the key's answer on `/metrics` is unchanged.
    if (scopes.includes(WILDCARD_SCOPE)) continue;
    const role =
      row.user_role !== null
        ? resolveEffectiveUserRole(row.user_role, row.user_role_name)
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
