import { and, eq, isNull } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "../db/client.ts";
import { tenants } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";
import { enqueueCatalogDescribe } from "../queue/handlers/catalog-describe.ts";
import { hasPendingCatalogDescriptions } from "../workflows/catalog-describe.ts";

export async function runCatalogDescribeSweep(db: Db, boss: PgBoss): Promise<void> {
  // tenant-filter:exempt — the describe sweep visits every tenant; each job carries its tenant_id
  const all = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(isNull(tenants.deleted_at), eq(tenants.status, "active")));
  for (const tenant of all) {
    try {
      if (!(await hasPendingCatalogDescriptions(tenant.id, db))) continue;
      await enqueueCatalogDescribe(boss, { tenant_id: tenant.id });
    } catch (err) {
      logger.error({
        module: "scheduler",
        action: "catalog_describe.enqueue_failed",
        msg: "failed to enqueue catalog description for tenant — continuing with the rest",
        tenant_id: tenant.id,
        ...errorFields(err),
      });
    }
  }
}
