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

export interface WorkflowConnectorReference {
  step_id: string;
  connector_id: string | null;
  slug: string | null;
  name: string | null;
  reason: "available" | "deleted" | "missing";
}

export interface ConnectorReferenceRecord {
  id: string;
  slug: string;
  name: string;
  deleted_at: Date | null;
}

export function connectorReferencesForDefinition(
  definition: unknown,
  records: ConnectorReferenceRecord[],
): WorkflowConnectorReference[] {
  if (!definition || typeof definition !== "object" || !("steps" in definition)) return [];
  if (!Array.isArray(definition.steps)) return [];
  const byId = new Map(records.map((record) => [record.id, record]));
  const bySlug = new Map<string, ConnectorReferenceRecord>();
  for (const record of records) {
    if (!bySlug.has(record.slug) || !record.deleted_at) bySlug.set(record.slug, record);
  }
  const references: WorkflowConnectorReference[] = [];
  for (const value of definition.steps) {
    if (!value || typeof value !== "object" || typeof value.id !== "string") continue;
    const step = value as Record<string, unknown> & { id: string };
    const seen = new Set<string>();
    const append = (
      record: ConnectorReferenceRecord | undefined,
      id: string | null,
      slug: string | null,
    ) => {
      const key = record?.id ?? id ?? slug;
      if (!key || seen.has(key)) return;
      seen.add(key);
      references.push({
        step_id: step.id,
        connector_id: record?.id ?? id,
        slug: record?.slug ?? slug,
        name: record?.name ?? null,
        reason: record ? (record.deleted_at ? "deleted" : "available") : "missing",
      });
    };
    if (typeof step.connector_id === "string") {
      append(byId.get(step.connector_id), step.connector_id, null);
    }
    if (typeof step.url === "string") {
      for (const slug of placeholderSlugsIn(step.url)) append(bySlug.get(slug), null, slug);
    }
  }
  return references;
}

export async function loadConnectorReferenceRecords(
  tenant_id: string,
  exec: Executor,
): Promise<ConnectorReferenceRecord[]> {
  return exec
    .select({
      id: connectors.id,
      slug: connectors.slug,
      name: connectors.display_name,
      deleted_at: connectors.deleted_at,
    })
    .from(connectors)
    .where(eq(connectors.tenant_id, tenant_id));
}
