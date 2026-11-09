import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { catalogMetadataView } from "../api/catalog-metadata.ts";
import type { Executor } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { definitionWithoutDescription, workflowJsonDigest } from "./canonical-json.ts";
import {
  connectorReferencesForDefinition,
  loadConnectorReferenceRecords,
} from "./connector-refs.ts";
import { invalidDefinitionForRead, readStoredDefinition } from "./stored-definition.ts";
import type { WorkflowDef } from "./types.ts";
import { readVersionAuthor } from "./version-author.ts";
import type { WorkflowView } from "./view.ts";

export async function loadWorkflowView(
  tenant_id: string,
  id: string,
  exec: Executor,
): Promise<WorkflowView | null> {
  const rows = await exec
    .select()
    .from(workflows)
    .where(
      and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, id), isNull(workflows.deleted_at)),
    )
    .limit(1);
  return (await workflowViewsFromRows(tenant_id, rows, exec))[0] ?? null;
}

export async function workflowViewsFromRows(
  tenant_id: string,
  rows: Array<typeof workflows.$inferSelect>,
  exec: Executor,
): Promise<WorkflowView[]> {
  const versionIds = rows.flatMap((wf) => (wf.current_version_id ? [wf.current_version_id] : []));
  const workflowIds = rows.map((wf) => wf.id);
  const versions = workflowIds.length
    ? await exec
        .select({
          id: workflowVersions.id,
          workflow_id: workflowVersions.workflow_id,
          author_user_id: workflowVersions.author_user_id,
          author_system_account_id: workflowVersions.author_system_account_id,
          version: workflowVersions.version,
          dag: workflowVersions.dag,
        })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.tenant_id, tenant_id),
            inArray(workflowVersions.workflow_id, workflowIds),
            or(
              eq(workflowVersions.version, 1),
              ...(versionIds.length ? [inArray(workflowVersions.id, versionIds)] : []),
            ),
          ),
        )
    : [];
  const connectorRecords = rows.length ? await loadConnectorReferenceRecords(tenant_id, exec) : [];
  const byId = new Map(versions.map((v) => [v.id, v]));
  const originals = new Map(versions.filter((v) => v.version === 1).map((v) => [v.workflow_id, v]));
  return rows.map((wf) => {
    const current = wf.current_version_id ? byId.get(wf.current_version_id) : undefined;
    const v = current?.workflow_id === wf.id ? current : undefined;
    const original = originals.get(wf.id);
    const stored = v ? readStoredDefinition(v.dag) : null;
    const storedDef: WorkflowDef = stored
      ? stored.invalid
        ? invalidDefinitionForRead(v?.dag, wf.name)
        : stored.definition
      : { name: wf.name, steps: [] };
    const withoutDescription = definitionWithoutDescription(storedDef);
    const definition: WorkflowDef = wf.description
      ? { ...withoutDescription, description: wf.description }
      : withoutDescription;
    const metadata = catalogMetadataView(wf);
    return {
      id: wf.id,
      connector_references: connectorReferencesForDefinition(v?.dag, connectorRecords),
      creator: original ? readVersionAuthor(original) : null,
      checksum: v ? workflowJsonDigest(v.dag) : null,
      tenant_id: wf.tenant_id,
      slug: wf.slug,
      name: wf.name,
      description: metadata.description,
      description_source: metadata.description_source,
      category: metadata.category,
      category_source: metadata.category_source,
      lifecycle: wf.lifecycle as "draft" | "active" | "archived",
      current_version_id: wf.current_version_id,
      draft_version_id: wf.draft_version_id,
      current_version: v?.version ?? null,
      created_at: wf.created_at,
      updated_at: wf.updated_at,
      last_executed_at: wf.last_executed_at ?? null,
      health_state: wf.health_state,
      health_reason: wf.health_reason ?? null,
      health_changed_at: wf.health_changed_at ?? null,
      invalid: stored?.invalid ?? false,
      definition,
      steps: definition.steps,
    };
  });
}
