import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { workflows, workflowVersions } from "../../db/schema/index.ts";
import { annotateRuntime } from "../../workflows/runtime-annotation.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import { validateWorkflowDef } from "../../workflows/validator.ts";
import { getWorkflowDraft } from "../authoring-state.ts";
import type { DraftDocument } from "../types.ts";
import { workflowDefFromDraft } from "./commit-workflow.ts";

export type DraftPersistedState =
  | { state: "clean" }
  | { state: "structural" }
  | {
      state: "no_target";
      reason: "unbound" | "empty_draft" | "no_persisted_version" | "unreadable_dag";
    };

const STRUCTURAL_KEYS = [
  "steps",
  "edges",
  "input_schema",
  "output_schema",
  "output_transform",
  "trigger",
] as const;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function structuralFingerprint(def: Record<string, unknown>): string {
  const picked: Record<string, unknown> = {};
  for (const k of STRUCTURAL_KEYS) {
    if (def[k] !== undefined) picked[k] = def[k];
  }
  return stableStringify(picked);
}

export async function classifyDraftVsPersisted(
  exec: Executor,
  tenant_id: string,
  draft: DraftDocument,
  target_workflow_id: string | null,
): Promise<DraftPersistedState> {
  if (!target_workflow_id) return { state: "no_target", reason: "unbound" };

  const draftDef = workflowDefFromDraft(getWorkflowDraft(draft));
  if (!Array.isArray(draftDef.steps) || draftDef.steps.length === 0) {
    return { state: "no_target", reason: "empty_draft" };
  }

  const wfRows = await exec
    .select({
      current_version_id: workflows.current_version_id,
      draft_version_id: workflows.draft_version_id,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, target_workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  const currentVersionId = wfRows[0]?.draft_version_id ?? wfRows[0]?.current_version_id;
  if (!currentVersionId) return { state: "no_target", reason: "no_persisted_version" };
  const bound = draft.state?.persisted_resources.find(
    (resource) => resource.kind === "workflow" && resource.id === target_workflow_id,
  );
  if (bound?.persistence_kind === "draft" && bound.version_id !== currentVersionId) {
    return { state: "structural" };
  }

  const versionRows = await exec
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, tenant_id),
        eq(workflowVersions.workflow_id, target_workflow_id),
        eq(workflowVersions.id, currentVersionId),
      ),
    )
    .limit(1);
  const dag = versionRows[0]?.dag;
  if (!dag) return { state: "no_target", reason: "unreadable_dag" };

  const parsedCurrent = WorkflowDefSchema.safeParse(dag);
  if (!parsedCurrent.success) return { state: "no_target", reason: "unreadable_dag" };

  const validated = validateWorkflowDef(draftDef);
  const draftForCompare =
    validated.ok && validated.workflow
      ? (annotateRuntime(validated.workflow) as unknown as Record<string, unknown>)
      : (draftDef as unknown as Record<string, unknown>);

  const same =
    structuralFingerprint(draftForCompare) ===
    structuralFingerprint(parsedCurrent.data as unknown as Record<string, unknown>);
  return same ? { state: "clean" } : { state: "structural" };
}
