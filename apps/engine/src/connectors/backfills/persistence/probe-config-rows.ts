import { and, eq, inArray, isNull } from "drizzle-orm";
import { connectors, type Db, dataMigrations } from "../../../db/index.ts";

export interface ProbeConfigRow {
  id: string;
  tenant_id: string;
  template_slug: string | null;
  config: Record<string, unknown>;
}

export async function connectorBackfillRan(db: Db, name: string): Promise<boolean> {
  const marker = await db
    .select({ name: dataMigrations.name })
    .from(dataMigrations) // tenant-filter:exempt — boot data-migration ledger
    .where(eq(dataMigrations.name, name))
    .limit(1);
  return marker[0] !== undefined;
}

export async function markConnectorBackfillRan(db: Db, name: string): Promise<void> {
  await db.insert(dataMigrations).values({ name }).onConflictDoNothing();
}

export async function templateConnectorRows(
  db: Db,
  templateSlugs: readonly string[],
): Promise<ProbeConfigRow[]> {
  return db
    .select({
      id: connectors.id,
      tenant_id: connectors.tenant_id,
      template_slug: connectors.template_slug,
      config: connectors.config,
    })
    .from(connectors) // tenant-filter:exempt — one-shot boot backfill walks every tenant
    .where(
      and(inArray(connectors.template_slug, [...templateSlugs]), isNull(connectors.deleted_at)),
    );
}

export async function writeConnectorConfig(
  db: Db,
  row: Pick<ProbeConfigRow, "id" | "tenant_id">,
  config: Record<string, unknown>,
): Promise<void> {
  await db
    .update(connectors)
    .set({ config })
    .where(and(eq(connectors.tenant_id, row.tenant_id), eq(connectors.id, row.id)));
}
