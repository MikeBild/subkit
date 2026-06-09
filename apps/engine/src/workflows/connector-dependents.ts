// Connector → workflow dependency lookup. Extracted from `service.ts`
// so that file stays under the 1000-LOC audit-invariant ceiling.
//
// Used as the dependency backstop before a connector delete: deleting a
// connector that a live workflow's step binds to would break that
// workflow at its next run.

import { and, eq, isNull } from "drizzle-orm";
import { type Db, getDb } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

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
 * The DAG is `workflow_versions.dag` (JSON); a step binds a connector via
 * `steps[].connector_id` (a UUID). The candidate set is bounded by the
 * tenant's live workflows, so we join to the current version and filter
 * the step list in TS rather than reaching into the jsonb.
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
      dag: workflowVersions.dag,
    })
    .from(workflows)
    .innerJoin(
      workflowVersions,
      and(
        eq(workflowVersions.tenant_id, tenant_id),
        eq(workflowVersions.id, workflows.current_version_id),
      ),
    )
    .where(and(eq(workflows.tenant_id, tenant_id), isNull(workflows.deleted_at)));
  const dependents: WorkflowConnectorDependent[] = [];
  for (const row of rows) {
    const dag = row.dag as { steps?: unknown } | null;
    const steps = Array.isArray(dag?.steps) ? dag.steps : [];
    const usesConnector = steps.some(
      (step) =>
        typeof step === "object" &&
        step !== null &&
        (step as { connector_id?: unknown }).connector_id === connector_id,
    );
    if (usesConnector) dependents.push({ id: row.id, slug: row.slug, name: row.name });
  }
  return dependents;
}
