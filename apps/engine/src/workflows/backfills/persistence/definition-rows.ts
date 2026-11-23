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

export interface VersionDefinitionRow {
  version_id: string;
  workflow_id: string;
  tenant_id: string;
  slug: string;
  version: number;
  current: boolean;
  dag: unknown;
}

export async function versionDefinitionRows(db: Db): Promise<VersionDefinitionRow[]> {
  const rows = await db
    .select({
      version_id: workflowVersions.id,
      workflow_id: workflows.id,
      tenant_id: workflows.tenant_id,
      slug: workflows.slug,
      version: workflowVersions.version,
      current_version_id: workflows.current_version_id,
      dag: workflowVersions.dag,
    })
    .from(workflowVersions) // tenant-filter:exempt — one-shot boot backfill walks every tenant
    .innerJoin(
      workflows,
      and(
        eq(workflows.tenant_id, workflowVersions.tenant_id),
        eq(workflows.id, workflowVersions.workflow_id),
      ),
    )
    .where(isNull(workflows.deleted_at));
  return rows.map(({ current_version_id, ...row }) => ({
    ...row,
    current: current_version_id === row.version_id,
  }));
}

const IMMUTABLE_VERSION = "23514";

export async function rewriteVersionDefinition(
  db: Db,
  row: Pick<VersionDefinitionRow, "tenant_id" | "version_id">,
  dag: unknown,
): Promise<"rewritten" | "immutable"> {
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(workflowVersions)
        .set({ dag })
        .where(
          and(
            eq(workflowVersions.tenant_id, row.tenant_id),
            eq(workflowVersions.id, row.version_id),
          ),
        );
    });
    return "rewritten";
  } catch (err) {
    const code =
      (err as { code?: unknown; cause?: { code?: unknown } }).code ??
      (err as { cause?: { code?: unknown } }).cause?.code;
    if (code === IMMUTABLE_VERSION) return "immutable";
    throw err;
  }
}
