import { and, eq, gt, isNull, lte } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../../audit/index.ts";
import type { Db } from "../../db/client.ts";
import { tenants } from "../../db/schema/index.ts";
import { tenantWorkBootId, withTenantWork } from "../../execution/tenant-work.ts";
import { lockActiveTenant } from "../../identity/index.ts";
import { errorFields, logger } from "../../logging/index.ts";
import { enqueueCatalogDescribe } from "../../queue/handlers/catalog-describe.ts";
import {
  acquireSweepPage,
  completeSweepEpoch,
  releaseSweepLease,
  walkSweepPage,
  withLiveSweepLease,
} from "../../scheduler/sweep-cursor.ts";
import { hasPendingCatalogDescriptions } from "../catalog-describe.ts";

export async function runCatalogDescribeSweep(db: Db, boss: PgBoss): Promise<void> {
  const page = await acquireSweepPage("catalog", tenantWorkBootId(), db);
  if (page.kind !== "claimed") return;
  let lease = page.lease;
  try {
    const walked = await walkSweepPage(page, db, (candidate, handle) =>
      withTenantWork(candidate.tenant_id, async () => {
        try {
          const result = await withLiveSweepLease(handle, db, async (tx) => {
            await lockActiveTenant(candidate.tenant_id, tx);
            const [tenant] = await tx
              .select({ id: tenants.id })
              .from(tenants)
              .where(
                and(
                  eq(tenants.id, candidate.tenant_id),
                  eq(tenants.id, candidate.id),
                  lte(tenants.created_at, handle.epoch_cutoff_at),
                  lte(tenants.id, handle.epoch_upper_id),
                  ...(handle.after_id ? [gt(tenants.id, handle.after_id)] : []),
                  eq(tenants.status, "active"),
                  isNull(tenants.deleted_at),
                ),
              )
              .limit(1);
            if (!tenant || !(await hasPendingCatalogDescriptions(tenant.id, tx)))
              return "visited" as const;
            const jobId = await enqueueCatalogDescribe(boss, { tenant_id: tenant.id }, tx);
            await auditAwait(
              {
                tenant_id: SYSTEM_TENANT_ID,
                actor_type: "system",
                actor_id: null,
                action: AuditAction.SCHEDULER_SWEEP_QUEUE_ADMITTED,
                resource_type: "scheduler_sweep",
                resource_id: "catalog",
                result: "success",
                metadata: {
                  request_source: "scheduler",
                  producer: "catalog",
                  epoch: handle.epoch,
                  revision: handle.revision,
                  outcome: jobId === null ? "no_new_job" : "created",
                },
              },
              tx,
            );
            return jobId === null ? ("visited" as const) : ("admitted" as const);
          });
          return typeof result === "object" ? "deferred" : result;
        } catch (err) {
          logger.error({
            module: "scheduler",
            action: "catalog_describe.enqueue_failed",
            msg: "failed to enqueue catalog description for tenant — continuing with the rest",
            tenant_id: candidate.tenant_id,
            ...errorFields(err),
          });
          throw err;
        }
      }),
    );
    if (walked.kind === "lost_lease") return;
    lease = walked.lease;
    await completeSweepEpoch(lease, db);
  } finally {
    await releaseSweepLease(lease, db);
  }
}
