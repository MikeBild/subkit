import { and, eq, isNull, sql } from "drizzle-orm";
import {
  type Db,
  dataMigrations,
  type Executor,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../../../db/index.ts";

export interface CurrentDefinitionRow {
  workflow_id: string;
  tenant_id: string;
  slug: string;
  version: number;
  dag: unknown;
}

export async function backfillAlreadyRan(db: Db, name: string): Promise<boolean> {
  const marker = await db
    .select({ name: dataMigrations.name })
    .from(dataMigrations) // tenant-filter:exempt — boot data-migration ledger
    .where(eq(dataMigrations.name, name))
    .limit(1);
  return marker[0] !== undefined;
}

export async function markBackfillRan(db: Db, name: string): Promise<void> {
  await db.insert(dataMigrations).values({ name }).onConflictDoNothing();
}

export async function currentDefinitionRows(db: Db): Promise<CurrentDefinitionRow[]> {
  return db
    .select({
      workflow_id: workflows.id,
      tenant_id: workflows.tenant_id,
      slug: workflows.slug,
      version: workflowVersions.version,
      dag: workflowVersions.dag,
    })
    .from(workflows) // tenant-filter:exempt — one-shot boot backfill walks every tenant
    .innerJoin(workflowVersions, eq(workflowVersions.id, workflows.current_version_id))
    .where(isNull(workflows.deleted_at));
}

export async function scheduleRowCount(
  exec: Executor,
  tenant_id: string,
  workflow_id: string,
): Promise<number> {
  const rows = await exec
    .select({ c: sql<number>`count(*)::int` })
    .from(workflowsSchedules)
    .where(
      and(
        eq(workflowsSchedules.tenant_id, tenant_id),
        eq(workflowsSchedules.workflow_id, workflow_id),
      ),
    );
  return Number(rows[0]?.c ?? 0);
}
