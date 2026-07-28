// Which connectors does a workflow actually use?
//
// A step binds a connector two different ways, and answering with only one of
// them under-reports:
//   1. `steps[].connector_id` — a UUID the driver resolves to a saved connector.
//   2. `${connector.<slug>.base_url}` inside a request step's `url`, resolved by
//      the substitution layer (see `workflows/validator.ts`, shape 2).
//
// This module is the single complete answer, used by the by-connector list
// filter, the `connectors[]` column on the workflow list, and the delete-time
// dependency guard — so "used by" means the same thing everywhere.
//
// Both projections are pushed into Postgres with `jsonb_path_query_array`, so
// only the connector ids and the url strings cross the wire. The DAGs
// themselves are never deserialised here: the list path is hot and the summary
// path deliberately avoids loading `dag` at all.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { type Executor, getDb } from "../db/client.ts";
import { connectors, workflows, workflowVersions } from "../db/schema/index.ts";

/**
 * Matches a connector placeholder anywhere in a url. The slug charset mirrors
 * the validator's `\$\{connector\.[a-z0-9_-]+\.base_url\}` check; the trailing
 * property is left open so a future `${connector.<slug>.<other>}` still counts
 * as a reference rather than silently dropping out of the dependency answer.
 */
const CONNECTOR_PLACEHOLDER = /\$\{connector\.([a-z0-9_-]+)\./gi;

/** Connector slugs referenced by a url string, in first-seen order. */
export function placeholderSlugsIn(url: string): string[] {
  const out: string[] = [];
  for (const match of url.matchAll(CONNECTOR_PLACEHOLDER)) {
    const slug = match[1];
    if (slug && !out.includes(slug)) out.push(slug);
  }
  return out;
}

/**
 * Map every LIVE workflow of a tenant to the connector slugs its current
 * version references, by BOTH binding forms. Slugs are sorted so the rendered
 * column is stable across runs.
 */
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
      // An id with no surviving connector is a dangling reference, not a
      // usage — reporting the raw uuid would read as a connector name.
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

/**
 * Ids of the LIVE workflows referencing a connector, identified by id or slug.
 * Returns an empty set when the connector does not resolve, so a bogus filter
 * value yields "nothing uses it" rather than the whole catalog.
 */
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
        // Accept either handle: the API takes a uuid, humans and the CLI type
        // the slug. `::text` keeps a non-uuid input from erroring the compare.
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

/**
 * LIVE workflows that would break if the given connector were deleted.
 *
 * The delete-time dependency guard and the by-connector list filter must agree
 * on what "uses this connector" means, so both resolve through
 * `workflowIdsUsingConnector` above. Before that consolidation this guard
 * matched `steps[].connector_id` only and silently cleared a delete whose sole
 * reference was a `${connector.<slug>.base_url}` placeholder.
 */
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
