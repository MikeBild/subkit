// Connector → workflow dependency lookup. Extracted from `service.ts`
// so that file stays under the 1000-LOC audit-invariant ceiling.
//
// Used as the dependency backstop before a connector delete: deleting a
// connector that a live workflow's step binds to would break that
// workflow at its next run.

import { and, eq, isNull, sql } from "drizzle-orm";
import { type Executor, getDb } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";

export interface WorkflowConnectorDependent {
  id: string;
  slug: string;
  name: string;
}

/**
 * List LIVE workflows whose current version DAG references the given
 * connector. Tenant-scoped on both the workflows and the
 * workflow_versions read.
 *
 * The DAG is `workflow_versions.dag` (jsonb); a step binds a connector via
 * `steps[].connector_id` (a UUID). The step-binding check is pushed into SQL
 * via `jsonb_path_exists`, so the filter runs at constant per-row cost in
 * postgres rather than deserialising every live workflow's DAG in-process —
 * this path is hot (the delete confirm card and the dispatch backstop both
 * call it). Tenant-scoped on both the workflows and workflow_versions reads.
 */
export async function listWorkflowsUsingConnector(
  tenant_id: string,
  connector_id: string,
  exec?: Executor,
): Promise<WorkflowConnectorDependent[]> {
  const db = exec ?? getDb();
  const rows = await db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
    })
    .from(workflows)
    .innerJoin(
      workflowVersions,
      and(
        eq(workflowVersions.tenant_id, tenant_id),
        eq(workflowVersions.id, workflows.current_version_id),
      ),
    )
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        isNull(workflows.deleted_at),
        // Matches any step whose connector_id equals the target. `$cid` is
        // bound from the vars object so the uuid is parameterised, not
        // string-interpolated into the jsonpath.
        sql`jsonb_path_exists(${workflowVersions.dag}, '$.steps[*] ? (@.connector_id == $cid)', jsonb_build_object('cid', ${connector_id}::text))`,
      ),
    );
  return rows.map((row) => ({ id: row.id, slug: row.slug, name: row.name }));
}
