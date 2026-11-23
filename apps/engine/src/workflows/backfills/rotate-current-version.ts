import type { Db } from "../../db/index.ts";
import type { WorkflowDef } from "../types.ts";
import { rotateWorkflowVersionInternal } from "../version-rotate.ts";
import { scheduleRowCount } from "./persistence/definition-rows.ts";

export interface RotateCurrentVersionInput {
  tenant_id: string;
  workflow_id: string;
  def: WorkflowDef;
  note: string;
  audit_metadata: Record<string, unknown>;
}

export async function rotateCurrentVersion(
  db: Db,
  input: RotateCurrentVersionInput,
): Promise<{ version: number }> {
  return db.transaction(async (tx) => {
    const schedulesBefore = await scheduleRowCount(tx, input.tenant_id, input.workflow_id);
    const rotated = await rotateWorkflowVersionInternal(input, tx);
    const schedulesAfter = await scheduleRowCount(tx, input.tenant_id, input.workflow_id);
    if (schedulesBefore !== schedulesAfter) {
      throw new Error(
        `workflows_schedules row-count parity violated (${schedulesBefore} → ${schedulesAfter})`,
      );
    }
    return { version: rotated.version };
  });
}
