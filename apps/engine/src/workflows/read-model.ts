import { compareCategoryCounts } from "../api/catalog-metadata.ts";
import type { Executor } from "../db/client.ts";
import {
  bindingFor,
  loadTriggerBindings,
  type TriggerBinding,
} from "../scheduler/trigger-bindings.ts";
import { type ListWorkflowsOptions, loadCategoryVocabulary } from "./catalog-view.ts";
import { listConnectorRefs } from "./connector-refs.ts";
import { getWorkflow, getWorkflowBySlug, listWorkflows } from "./service.ts";
import type { WorkflowView } from "./view.ts";

export interface WorkflowListEntry {
  workflow: WorkflowView;
  binding: TriggerBinding;
  connectors: string[];
}

export interface WorkflowListProjection {
  entries: WorkflowListEntry[];
  total: number;
}

export interface WorkflowCategoryBlock {
  category: string;
  count: number;
}

export interface WorkflowDetailEntry {
  workflow: WorkflowView;
  binding: TriggerBinding;
}

export type WorkflowLookup = { id: string } | { slug: string };

export async function loadWorkflowList(
  tenantId: string,
  opts: ListWorkflowsOptions,
  db: Executor,
): Promise<WorkflowListProjection> {
  const { rows, total } = await listWorkflows(tenantId, opts, db);
  const [connectorRefs, bindings] = await Promise.all([
    listConnectorRefs(tenantId, db),
    loadTriggerBindings(
      tenantId,
      rows.map((w) => w.id),
      db,
    ),
  ]);
  return {
    entries: rows.map((workflow) => ({
      workflow,
      binding: bindingFor(bindings, workflow.id),
      connectors: connectorRefs.get(workflow.id) ?? [],
    })),
    total,
  };
}

export async function loadWorkflowCategoryBlocks(
  tenantId: string,
  db: Executor,
): Promise<WorkflowCategoryBlock[]> {
  const vocabulary = await loadCategoryVocabulary(tenantId, db);
  return vocabulary
    .filter((usage) => usage.counts.workflow > 0)
    .map((usage) => ({ category: usage.category, count: usage.counts.workflow }))
    .sort(compareCategoryCounts);
}

export async function loadWorkflowDetail(
  tenantId: string,
  lookup: WorkflowLookup,
  db: Executor,
): Promise<WorkflowDetailEntry | null> {
  const workflow =
    "id" in lookup
      ? await getWorkflow(tenantId, lookup.id, db)
      : await getWorkflowBySlug(tenantId, lookup.slug, db);
  if (!workflow) return null;
  return { workflow, binding: await loadWorkflowBinding(tenantId, workflow.id, db) };
}

export async function loadWorkflowBinding(
  tenantId: string,
  workflowId: string,
  db: Executor,
): Promise<TriggerBinding> {
  const bindings = await loadTriggerBindings(tenantId, [workflowId], db);
  return bindingFor(bindings, workflowId);
}
