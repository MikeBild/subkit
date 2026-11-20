import { z } from "@hono/zod-openapi";
import type { Executor } from "../../db/client.ts";
import { writeEvent } from "../../db/events.ts";

const Remedy = <K extends string>(kind: K) =>
  z.object({
    kind: z.literal(kind),
    href: z.string().describe("Router path under /cockpit where a person applies the remedy."),
  });

export const ScheduleAutoPausedPayloadSchema = z.object({
  severity: z.literal("error"),
  workflow_id: z.string().uuid(),
  workflow_name: z.string().nullable(),
  schedule_id: z.string().uuid(),
  environment: z.enum(["dev", "prod"]),
  paused_reason: z.literal("repeated_failures"),
  failure_class: z.string(),
  consecutive_failures: z.number().int().positive(),
  paused_at: z.string().datetime(),
  remedy: Remedy("resume"),
});
export type ScheduleAutoPausedPayload = z.infer<typeof ScheduleAutoPausedPayloadSchema>;

export const WorkflowApprovalExpiringPayloadSchema = z.object({
  severity: z.literal("warn"),
  workflow_id: z.string().uuid(),
  workflow_name: z.string().nullable(),
  authority_id: z.string().uuid(),
  environment: z.enum(["dev", "prod"]),
  valid_until: z.string().datetime(),
  remedy: Remedy("renew"),
});
export type WorkflowApprovalExpiringPayload = z.infer<typeof WorkflowApprovalExpiringPayloadSchema>;

export const TaskGrantExpiringPayloadSchema = z.object({
  severity: z.literal("warn"),
  task_id: z.string().uuid(),
  task_name: z.string().nullable(),
  grant_id: z.string().uuid(),
  environment: z.enum(["dev", "prod"]),
  valid_until: z.string().datetime(),
  remedy: Remedy("renew"),
});
export type TaskGrantExpiringPayload = z.infer<typeof TaskGrantExpiringPayloadSchema>;

export const SCHEDULE_EVENT_SCHEMAS = {
  "schedule.auto_paused": ScheduleAutoPausedPayloadSchema,
  "workflow.approval_expiring": WorkflowApprovalExpiringPayloadSchema,
  "task.grant_expiring": TaskGrantExpiringPayloadSchema,
} as const;
export type ScheduleEventType = keyof typeof SCHEDULE_EVENT_SCHEMAS;

export async function emitScheduleEvent<T extends ScheduleEventType>(
  tx: Executor,
  tenant_id: string,
  type: T,
  payload: z.input<(typeof SCHEDULE_EVENT_SCHEMAS)[T]>,
): Promise<void> {
  const schema: z.ZodTypeAny = SCHEDULE_EVENT_SCHEMAS[type];
  await writeEvent(tx, {
    tenant_id,
    channel: "notification.emitted",
    type,
    payload: schema.parse(payload) as Record<string, unknown>,
  });
}
