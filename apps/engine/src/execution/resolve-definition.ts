import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { executableDefinition } from "../workflows/stored-definition.ts";
import type { StepDef, WorkflowDef } from "../workflows/types.ts";
import { validateWorkflowDef } from "../workflows/validator.ts";

export type RunExecutionSource =
  | { kind: "saved"; workflow_id: string; version_id?: string }
  | { kind: "draft"; definition: WorkflowDef | unknown; name?: string }
  | { kind: "step"; step: StepDef | unknown; workflow_slug?: string };

export interface ResolvedDefinition {
  def: WorkflowDef;
  workflow_id: string;
  workflow_version_id: string;
  workflow_slug: string;
  source_kind: "saved" | "draft" | "step";
  source_ref: Record<string, unknown> | null;
  persist_workflow_refs: boolean;
}

function synthUuid(): string {
  return crypto.randomUUID();
}

function hashDefinition(def: WorkflowDef): string {
  const json = JSON.stringify(def);
  let h = 0;
  for (let i = 0; i < json.length; i++) {
    h = ((h << 5) - h + json.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

async function resolveSaved(
  db: Executor,
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
  if (wfRow.lifecycle === "archived") {
    throw Object.assign(new Error(`workflow is archived: ${workflow_id}`), {
      code: "workflow_archived",
    });
  }
  const versionId = version_id ?? wfRow.current_version_id;
  if (!versionId)
    throw Object.assign(new Error("workflow has no current version"), {
      code: "workflow_version_not_active",
    });
  const versionRows = await db
    .select()
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, tenant_id),
        eq(workflowVersions.workflow_id, workflow_id),
        eq(workflowVersions.id, versionId),
      ),
    )
    .limit(1);
  const versionRow = versionRows[0];
  if (!versionRow)
    throw Object.assign(new Error("workflow version not found"), {
      code: "workflow_version_unavailable",
    });
  const def = executableDefinition(versionRow.dag);
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
  db: Executor,
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
