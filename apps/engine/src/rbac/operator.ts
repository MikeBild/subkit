import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { SYSTEM_TENANT_ID } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Executor } from "../db/client.ts";
import { tenants } from "../db/schema/index.ts";

export class OperatorTenantMissingError extends Error {
  readonly code = "operator_tenant_missing";
}

const memo = new WeakMap<ResolvedPrincipal, Promise<boolean>>();

export async function tenantIsOperator(db: Executor, tenantId: string): Promise<boolean> {
  // tenant-filter:exempt — operator flag is the tenant row itself
  const rows = await db
    .select({ is_operator: tenants.is_operator })
    .from(tenants)
    .where(and(eq(tenants.id, tenantId), isNull(tenants.deleted_at)))
    .limit(1);
  return rows[0]?.is_operator === true;
}

export function isOperatorPrincipal(db: Executor, principal: ResolvedPrincipal): Promise<boolean> {
  if (principal.product_id) return Promise.resolve(false);
  if (principal.provider === "portal_token") return Promise.resolve(false);
  if (principal.tenant_id === SYSTEM_TENANT_ID) return Promise.resolve(false);
  const cached = memo.get(principal);
  if (cached) return cached;
  const pending = tenantIsOperator(db, principal.tenant_id);
  memo.set(principal, pending);
  pending.catch(() => memo.delete(principal));
  return pending;
}

export async function operatorTenant(db: Executor): Promise<{ id: string; slug: string } | null> {
  // tenant-filter:exempt — locating the single operator tenant row
  const rows = await db
    .select({ id: tenants.id, slug: tenants.slug })
    .from(tenants)
    .where(and(eq(tenants.is_operator, true), isNull(tenants.deleted_at)))
    .orderBy(asc(tenants.created_at))
    .limit(1);
  return rows[0] ?? null;
}

export async function operatorTenantId(db: Executor): Promise<string | null> {
  return (await operatorTenant(db))?.id ?? null;
}

const OPERATOR_CLAIM_LOCK = "subkit:operator-tenant-claim";

export async function claimOperatorTenantIfUnassigned(
  db: Executor,
  tenantId: string,
): Promise<boolean> {
  if (tenantId === SYSTEM_TENANT_ID) return false;
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${OPERATOR_CLAIM_LOCK}, 0))`);
  // tenant-filter:exempt — releasing the flag of deleted tenants so the single operator slot is claimable
  await db
    .update(tenants)
    .set({ is_operator: false })
    .where(and(eq(tenants.is_operator, true), isNotNull(tenants.deleted_at)));
  const rows = await db
    .update(tenants)
    .set({ is_operator: true })
    .where(
      and(
        eq(tenants.id, tenantId),
        isNull(tenants.deleted_at),
        sql`NOT EXISTS (SELECT 1 FROM ${tenants} WHERE ${tenants.is_operator})`,
      ),
    )
    .returning({ id: tenants.id });
  return rows.length > 0;
}
