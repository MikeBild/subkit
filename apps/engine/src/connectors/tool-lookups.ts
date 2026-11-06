import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { connectors } from "../db/schema/index.ts";

export type ConnectorRow = typeof connectors.$inferSelect;

export async function listTenantConnectorSlugs(
  db: Executor,
  tenant_id: string,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ slug: connectors.slug })
    .from(connectors)
    .where(eq(connectors.tenant_id, tenant_id))
    .orderBy(asc(connectors.slug))
    .limit(limit);
  return rows.map((r) => r.slug);
}

export async function findConnectorRowBySlug(
  db: Executor,
  tenant_id: string,
  slug: string,
  environment: "dev" | "prod" | null,
): Promise<ConnectorRow | undefined> {
  const rows = await db
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        eq(connectors.slug, slug),
        ...(environment ? [eq(connectors.environment, environment)] : []),
      ),
    )
    .limit(1);
  return rows[0];
}

export async function listConnectorsByIdsOrSlugs(
  db: Executor,
  tenant_id: string,
  ids: readonly string[],
  slugs: readonly string[],
): Promise<Array<{ id: string; slug: string }>> {
  const idFilter = ids.length > 0 ? inArray(connectors.id, [...ids]) : null;
  const slugFilter = slugs.length > 0 ? inArray(connectors.slug, [...slugs]) : null;
  const idOrSlugFilter =
    idFilter && slugFilter ? or(idFilter, slugFilter) : (idFilter ?? slugFilter);
  return db
    .select({ id: connectors.id, slug: connectors.slug })
    .from(connectors)
    .where(and(eq(connectors.tenant_id, tenant_id), idOrSlugFilter ?? undefined));
}
