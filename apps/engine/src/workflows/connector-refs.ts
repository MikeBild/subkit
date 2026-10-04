import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { type Executor, getDb } from "../db/client.ts";
import { connectors, workflows, workflowVersions } from "../db/schema/index.ts";

const CONNECTOR_PLACEHOLDER = /\$\{connector\.([a-z0-9_-]+)\./gi;

export function placeholderSlugsIn(url: string): string[] {
  const out: string[] = [];
  for (const match of url.matchAll(CONNECTOR_PLACEHOLDER)) {
    const slug = match[1];
    if (slug && !out.includes(slug)) out.push(slug);
  }
  return out;
}

export async function listConnectorRefs(
  tenant_id: string,
  exec?: Executor,
): Promise<Map<string, string[]>> {
  const db = exec ?? getDb();

  const [refRows, connectorRows] = await Promise.all([
    db
      .select({
        workflow_id: workflows.id,
        connector_ids: sql<
          unknown[]
        >`jsonb_path_query_array(${workflowVersions.dag}, '$.steps[*].connector_id')`,
        urls: sql<unknown[]>`jsonb_path_query_array(${workflowVersions.dag}, '$.steps[*].url')`,
      })
      .from(workflows)
      .innerJoin(
        workflowVersions,
        and(
          eq(workflowVersions.tenant_id, tenant_id),
          eq(workflowVersions.id, workflows.current_version_id),
        ),
      )
      .where(and(eq(workflows.tenant_id, tenant_id), isNull(workflows.deleted_at))),
    db
      .select({ id: connectors.id, slug: connectors.slug })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), isNull(connectors.deleted_at))),
  ]);

  const slugById = new Map(connectorRows.map((c) => [c.id, c.slug]));
  const knownSlugs = new Set(connectorRows.map((c) => c.slug));

  const out = new Map<string, string[]>();
  for (const row of refRows) {
    const slugs = new Set<string>();
    for (const id of row.connector_ids ?? []) {
      if (typeof id !== "string") continue;
      const slug = slugById.get(id);
      if (slug) slugs.add(slug);
    }
    for (const url of row.urls ?? []) {
      if (typeof url !== "string") continue;
      for (const slug of placeholderSlugsIn(url)) {
        if (knownSlugs.has(slug)) slugs.add(slug);
      }
    }
    out.set(row.workflow_id, [...slugs].sort());
  }
  return out;
}

export async function workflowIdsUsingConnector(
  tenant_id: string,
  connectorIdOrSlug: string,
  exec?: Executor,
): Promise<Set<string>> {
  const db = exec ?? getDb();
  const [connector] = await db
    .select({ slug: connectors.slug })
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        isNull(connectors.deleted_at),
        sql`(${connectors.id}::text = ${connectorIdOrSlug} OR ${connectors.slug} = ${connectorIdOrSlug})`,
      ),
    )
    .limit(1);
  if (!connector) return new Set();

  const refs = await listConnectorRefs(tenant_id, db);
  const out = new Set<string>();
  for (const [workflow_id, slugs] of refs) {
    if (slugs.includes(connector.slug)) out.add(workflow_id);
  }
  return out;
}

export interface WorkflowConnectorDependent {
  id: string;
  slug: string;
  name: string;
}

export async function listWorkflowsUsingConnector(
  tenant_id: string,
  connector_id: string,
  exec?: Executor,
): Promise<WorkflowConnectorDependent[]> {
  const db = exec ?? getDb();
  const ids = await workflowIdsUsingConnector(tenant_id, connector_id, db);
  if (ids.size === 0) return [];
  return db
    .select({ id: workflows.id, slug: workflows.slug, name: workflows.name })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        isNull(workflows.deleted_at),
        inArray(workflows.id, [...ids]),
      ),
    );
}
