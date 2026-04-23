// Resolver for the three first-class execution sources:
//   • saved — persisted workflow + current_version_id
//   • draft — inline WorkflowDef, no DB round-trip, no commit
//   • step  — single StepDef wrapped in a synthetic one-step WorkflowDef
//
// All three emit the same shape so the engine's runtime pipeline stays
// a single code path. The only difference is the origin of the
// definition and whether the executions row carries workflow_id /
// workflow_version_id (saved) or NULLs (draft, step).

import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { type StepDef, type WorkflowDef, WorkflowDefSchema } from "../workflows/types.ts";
import { validateWorkflowDef } from "../workflows/validator.ts";

/** Discriminated union identifying where the definition comes from. */
export type RunExecutionSource =
  | { kind: "saved"; workflow_id: string; version_id?: string }
  | { kind: "draft"; definition: WorkflowDef | unknown; name?: string }
  | { kind: "step"; step: StepDef | unknown; workflow_slug?: string };

export interface ResolvedDefinition {
  /** Fully-validated definition ready for the execution pipeline. */
  def: WorkflowDef;
  /** Real workflow id for saved runs; synthesized placeholder for draft/step
   *  (NOT persisted — the DB column is NULL for these sources). */
  workflow_id: string;
  /** Real workflow_version id for saved runs; synthesized placeholder
   *  otherwise. NOT persisted for draft/step. */
  workflow_version_id: string;
  /** Workflow slug for log lines and connector trace breadcrumbs. */
  workflow_slug: string;
  /** Mirrors the source kind; passed through to executions.source_kind. */
  source_kind: "saved" | "draft" | "step";
  /** Free-form metadata persisted to executions.source_ref. */
  source_ref: Record<string, unknown> | null;
  /** True when the DB row's workflow_id / workflow_version_id should be
   *  written as NULL (draft + step). */
  persist_workflow_refs: boolean;
}

function synthUuid(): string {
  return crypto.randomUUID();
}

function hashDefinition(def: WorkflowDef): string {
  // Cheap deterministic hash for source_ref tracking. Not cryptographic —
  // only meant to help operators correlate repeat draft-runs of the same
  // definition in the executions table.
  const json = JSON.stringify(def);
  let h = 0;
  for (let i = 0; i < json.length; i++) {
    h = ((h << 5) - h + json.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

async function resolveSaved(
  db: Db,
  tenant_id: string,
  workflow_id: string,
  version_id: string | undefined,
): Promise<ResolvedDefinition> {
  const wfRows = await db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  const wfRow = wfRows[0];
  if (!wfRow) throw new Error(`workflow not found: ${workflow_id}`);
  const versionId = version_id ?? wfRow.current_version_id;
  if (!versionId) throw new Error("workflow has no current version");
  const versionRows = await db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.id, versionId))
    .limit(1);
  const versionRow = versionRows[0];
  if (!versionRow) throw new Error("workflow version not found");
  const def = WorkflowDefSchema.parse(versionRow.dag);
  return {
    def,
    workflow_id: wfRow.id,
    workflow_version_id: versionRow.id,
    workflow_slug: wfRow.slug,
    source_kind: "saved",
    source_ref: null,
    persist_workflow_refs: true,
  };
}

function resolveDraft(definition: unknown, name: string | undefined): ResolvedDefinition {
  const validation = validateWorkflowDef(definition);
  if (!validation.ok || !validation.workflow) {
    const msg = validation.errors.map((e) => e.message).join("; ") || "invalid draft";
    throw Object.assign(new Error(msg), {
      code: "draft_invalid",
      details: validation.errors,
    });
  }
  const def = validation.workflow;
  return {
    def,
    workflow_id: synthUuid(),
    workflow_version_id: synthUuid(),
    workflow_slug: name ?? "draft",
    source_kind: "draft",
    source_ref: {
      definition_hash: hashDefinition(def),
      ...(name ? { name } : {}),
    },
    persist_workflow_refs: false,
  };
}

function resolveStep(step: unknown, workflow_slug: string | undefined): ResolvedDefinition {
  // Wrap the single step in a one-step WorkflowDef. Validation routes
  // through the normal validator so JSONata / data_selector / branch
  // references behave identically to a full workflow.
  const synthetic = {
    name: workflow_slug ?? "step-run",
    steps: [step],
  };
  const validation = validateWorkflowDef(synthetic);
  if (!validation.ok || !validation.workflow) {
    const msg = validation.errors.map((e) => e.message).join("; ") || "invalid step";
    throw Object.assign(new Error(msg), {
      code: "step_invalid",
      details: validation.errors,
    });
  }
  const def = validation.workflow;
  const stepRef = def.steps[0] as StepDef | undefined;
  return {
    def,
    workflow_id: synthUuid(),
    workflow_version_id: synthUuid(),
    workflow_slug: workflow_slug ?? "step-run",
    source_kind: "step",
    source_ref: {
      step_id: stepRef?.id ?? "step",
      step_kind: stepRef?.kind ?? "unknown",
    },
    persist_workflow_refs: false,
  };
}

export async function resolveDefinition(
  db: Db,
  tenant_id: string,
  source: RunExecutionSource,
): Promise<ResolvedDefinition> {
  switch (source.kind) {
    case "saved":
      return resolveSaved(db, tenant_id, source.workflow_id, source.version_id);
    case "draft":
      return resolveDraft(source.definition, source.name);
    case "step":
      return resolveStep(source.step, source.workflow_slug);
  }
}
