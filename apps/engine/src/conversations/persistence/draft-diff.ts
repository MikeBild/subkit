// Does a conversation's working draft hold workflow-DEFINITION edits that are
// not yet persisted to its bound workflow's current version?
//
// Two callers need this exact question:
//   - `conversation_commit` (MCP) — so it stops echoing "committed" when the
//     draft still has uncommitted edits (RC2: it is a read-only status tool and
//     must report honestly).
//   - `update_workflow` (metadata-only tool) — so it refuses to "save" a draft
//     whose STEPS changed (it writes only metadata via updateWorkflowMetadata and
//     would silently drop step edits; those belong on the save_workflow_draft path).
//
// We compare only the STRUCTURAL def fields (steps/edges/schemas/trigger/
// output_transform), never the metadata fields (name/slug/description/lifecycle).
// Two reasons: (1) `description` has dual storage — canonical in the
// `workflows.description` column, often null in the stored dag — so a metadata
// compare against the dag is unreliable; (2) metadata edits are exactly what
// `update_workflow` is FOR, so a pure metadata diff must not read as "dirty".
//
// The comparison mirrors the commit path (commit-workflow.ts): project the draft
// via `workflowDefFromDraft`, validate+annotate so it is like-for-like with the
// stored (already-annotated) dag, then structural-compare.

import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { workflows, workflowVersions } from "../../db/schema/index.ts";
import { annotateRuntime } from "../../workflows/runtime-annotation.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import { validateWorkflowDef } from "../../workflows/validator.ts";
import { getWorkflowDraft } from "../authoring-state.ts";
import type { DraftDocument } from "../types.ts";
import { workflowDefFromDraft } from "./commit-workflow.ts";

/**
 * - `no_target`   — nothing was compared. The `reason` says why:
 *                   `unbound` (no target workflow id), `empty_draft` (no steps
 *                   to compare), `no_persisted_version` (workflow row missing,
 *                   deleted, or has no current version), `unreadable_dag`
 *                   (a version row exists but its stored dag is missing or
 *                   fails schema parse).
 * - `clean`       — the draft's structural def matches the persisted current
 *                   version (any difference is metadata-only, which is fine).
 * - `structural`  — the draft's steps/edges/schemas/trigger/output_transform
 *                   differ from the persisted version (uncommitted def edits).
 */
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

/**
 * Classify a conversation's working draft against the persisted current version
 * of `target_workflow_id`. Best-effort and read-only: any ambiguity (unparseable
 * stored dag, draft that fails validation, no target) resolves to `no_target`
 * rather than a false `structural`, so neither caller blocks/denies on noise.
 */
export async function classifyDraftVsPersisted(
  exec: Executor,
  tenant_id: string,
  draft: DraftDocument,
  target_workflow_id: string | null,
): Promise<DraftPersistedState> {
  if (!target_workflow_id) return { state: "no_target", reason: "unbound" };

  const draftDef = workflowDefFromDraft(getWorkflowDraft(draft));
  if (!Array.isArray(draftDef.steps) || draftDef.steps.length === 0) {
    // An empty workflow draft (e.g. a connector-only or freshly-bound session
    // before any edit) has nothing to compare.
    return { state: "no_target", reason: "empty_draft" };
  }

  const wfRows = await exec
    .select({ current_version_id: workflows.current_version_id })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, target_workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  const currentVersionId = wfRows[0]?.current_version_id;
  if (!currentVersionId) return { state: "no_target", reason: "no_persisted_version" };

  const versionRows = await exec
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(
      and(eq(workflowVersions.tenant_id, tenant_id), eq(workflowVersions.id, currentVersionId)),
    )
    .limit(1);
  const dag = versionRows[0]?.dag;
  if (!dag) return { state: "no_target", reason: "unreadable_dag" };

  const parsedCurrent = WorkflowDefSchema.safeParse(dag);
  if (!parsedCurrent.success) return { state: "no_target", reason: "unreadable_dag" };

  // Annotate the draft def so the comparison is like-for-like with the stored
  // (annotated) dag; fall back to the raw projection if validation fails so an
  // in-progress invalid draft still compares rather than throwing.
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
