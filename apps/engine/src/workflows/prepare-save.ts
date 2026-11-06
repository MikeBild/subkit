import type { Executor } from "../db/client.ts";
import { applySkillSchemaGate, applyStorageBindingGate } from "./commit-gates.ts";
import { gateIssue } from "./core/definition.ts";
import { validateTenantWorkflowDefForSave } from "./tenant-validator.ts";
import type { WorkflowDef } from "./types.ts";
import type { ValidateOptions, ValidationError } from "./validator.ts";

type WorkflowSaveStage = "definition" | "skill_schema" | "storage_binding";

type PreparedWorkflowSave =
  | { ok: true; workflow: WorkflowDef }
  | { ok: false; stage: WorkflowSaveStage; errors: string[]; issues: ValidationError[] };

function refused(stage: WorkflowSaveStage, errors: string[]): PreparedWorkflowSave {
  return { ok: false, stage, errors, issues: errors.map(gateIssue) };
}

export async function prepareWorkflowSave(
  def: unknown,
  tenantId: string,
  db: Executor,
  options: Pick<ValidateOptions, "destinationTier"> = {},
): Promise<PreparedWorkflowSave> {
  const validation = await validateTenantWorkflowDefForSave(def, tenantId, db, options);
  if (!validation.ok || !validation.workflow) {
    return {
      ok: false,
      stage: "definition",
      errors: validation.errors.map((e) => `${e.path}: ${e.message}`),
      issues: validation.errors,
    };
  }
  const skillGate = await applySkillSchemaGate(tenantId, validation.workflow, db);
  if (!skillGate.ok) return refused("skill_schema", skillGate.errors);
  const storageGate = await applyStorageBindingGate(tenantId, validation.workflow, db);
  if (!storageGate.ok) return refused("storage_binding", storageGate.errors);
  return { ok: true, workflow: validation.workflow };
}
