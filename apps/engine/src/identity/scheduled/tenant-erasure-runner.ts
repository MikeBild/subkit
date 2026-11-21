import { and, asc, eq, isNull, lte, ne, or } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { tenantErasureStates, tenants } from "../../db/schema/index.ts";
import { tenantWorkSnapshot } from "../../execution/tenant-work.ts";
import { now } from "../../utils/clock.ts";
import { eraseExpiredTenant, type TenantErasureDependencies } from "../tenant-erasure.ts";

export async function runTenantErasureSweep(
  exec: Executor,
  dependencies: () => TenantErasureDependencies,
) {
  const bootId = tenantWorkSnapshot("").boot_id;
  // tenant-filter:exempt — bounded lifecycle sweep selects only expired self-service tenants and delegates exact-tenant erasure.
  const candidates = await exec
    .select({ id: tenants.id })
    .from(tenants)
    .leftJoin(tenantErasureStates, eq(tenantErasureStates.tenant_id, tenants.id))
    .where(
      and(
        or(
          isNull(tenantErasureStates.failure_code),
          ne(tenantErasureStates.failure_code, "tenant_reference_review_required"),
        ),
        eq(tenants.origin, "self_service"),
        eq(tenants.status, "pending_deletion"),
        isNull(tenants.deleted_at),
        lte(tenants.deletion_scheduled_for, new Date(now())),
        or(
          isNull(tenantErasureStates.lease_expires_at),
          lte(tenantErasureStates.lease_expires_at, new Date(now())),
        ),
        or(isNull(tenantErasureStates.tenant_id), eq(tenantErasureStates.drain_untracked, false)),
        or(
          isNull(tenantErasureStates.drain_boot_id),
          eq(tenantErasureStates.drain_boot_id, bootId),
        ),
      ),
    )
    .orderBy(asc(tenantErasureStates.updated_at), asc(tenants.id))
    .limit(20);
  if (candidates.length === 0) return { examined: 0, completed: 0, blocked: 0 };
  const deps = dependencies();
  let completed = 0;
  let blocked = 0;
  for (const candidate of candidates) {
    try {
      const result = await eraseExpiredTenant(candidate.id, deps, exec);
      if (result.status === "completed") completed += 1;
      if (result.status === "blocked") blocked += 1;
    } catch {
      blocked += 1;
    }
  }
  return { examined: candidates.length, completed, blocked };
}
