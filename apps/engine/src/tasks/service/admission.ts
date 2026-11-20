import { and, eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Executor } from "../../db/client.ts";
import { tasks } from "../../db/schema/index.ts";
import { emitResourceChange } from "../../pubsub/resource-changes.ts";
import type { TaskAdmissionReason, TaskRunTrigger } from "../types.ts";
import type { TaskRunSource } from "./run-rows.ts";

async function heldReason(
  tx: Executor,
  tenant_id: string,
  task_id: string,
): Promise<string | null | undefined> {
  const [row] = await tx
    .select({ reason: tasks.admission_hold_reason })
    .from(tasks)
    .where(and(eq(tasks.tenant_id, tenant_id), eq(tasks.id, task_id)))
    .for("update")
    .limit(1);
  return row ? row.reason : undefined;
}

export async function recordTaskAdmissionChange(
  tx: Executor,
  p: {
    tenant_id: string;
    task_id: string;
    trigger: TaskRunTrigger;
    reason: TaskAdmissionReason | null;
    at: Date;
    since?: Date | null;
    source?: TaskRunSource | undefined;
  },
): Promise<boolean> {
  const held = await heldReason(tx, p.tenant_id, p.task_id);
  if (held === undefined || held === p.reason) return false;
  await tx
    .update(tasks)
    .set({
      admission_hold_reason: p.reason,
      admission_hold_since: p.reason ? (p.since ?? p.at) : null,
    })
    .where(and(eq(tasks.tenant_id, p.tenant_id), eq(tasks.id, p.task_id)));
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      ts: p.at,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.TASK_ADMISSION_CHANGED,
      resource_type: "task",
      resource_id: p.task_id,
      result: p.reason ? "denied" : "success",
      reason: p.reason,
      metadata: {
        task_id: p.task_id,
        state: p.reason ? "held" : "admitted",
        reason_code: p.reason,
        trigger: p.trigger,
        request_source: p.source ?? "scheduler",
      },
    },
    tx,
  );
  await emitResourceChange(tx, {
    tenant_id: p.tenant_id,
    type: "task.changed",
    ids: { task_id: p.task_id },
  });
  return true;
}
