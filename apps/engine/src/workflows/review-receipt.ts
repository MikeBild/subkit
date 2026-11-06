import { z } from "@hono/zod-openapi";

const digest = z.string().regex(/^[a-f0-9]{64}$/);

const WorkflowReviewScheduleSchema = z
  .object({
    cron: z.string().min(1),
    timezone: z.string().min(1),
    input: z.unknown().optional(),
    paused: z.boolean().optional(),
  })
  .strict();
const WorkflowReviewGrantSchema = z
  .object({
    environment: z.enum(["dev", "prod"]),
    valid_from: z.string().datetime({ offset: true }),
    valid_until: z.string().datetime({ offset: true }).nullable().optional(),
    max_runs: z.number().int().min(1).max(10_000).nullable().optional(),
  })
  .strict();
export const PrepareWorkflowReviewSchema = z
  .object({
    elicitation_id: z.string().uuid(),
    activate: z.boolean().default(false),
    grant: WorkflowReviewGrantSchema.nullable().default(null),
    schedule: WorkflowReviewScheduleSchema.nullable().default(null),
  })
  .strict();
export const FinalizeWorkflowReviewSchema = z
  .object({ expected_snapshot_digest: digest, save_only: z.boolean().optional() })
  .strict();

const actions = z.object({
  activate: z.boolean(),
  grant: WorkflowReviewGrantSchema.nullable(),
  schedule: WorkflowReviewScheduleSchema.nullable(),
});
export const WorkflowReviewReceiptSchema = z
  .object({
    receipt_id: z.string().uuid(),
    status: z.enum(["pending", "completed"]),
    snapshot_digest: digest,
    expires_at: z.string().datetime(),
    workflow_name: z.string(),
    workflow_slug: z.string().nullable(),
    reviewed_version_number: z.number().int().nullable(),
    environment: z.enum(["dev", "prod"]).nullable(),
    description: z.string(),
    checks: z.array(z.string()),
    effects: z.array(
      z.object({
        step_id: z.string(),
        connector_name: z.string().nullable(),
        connector_slug: z.string().nullable(),
        effect: z.enum(["read", "write", "unknown"]),
        target: z.string().nullable(),
        details: z.array(z.string()).optional(),
      }),
    ),
    affected_triggers: z.array(
      z.object({
        kind: z.enum(["schedule", "webhook"]),
        name: z.string(),
        cron: z.string().optional(),
        timezone: z.string().optional(),
      }),
    ),
    actions,
    suggested_actions: actions,
    result: z
      .object({
        workflow_id: z.string().uuid(),
        authority_id: z.string().uuid().nullable(),
        schedule_id: z.string().uuid().nullable(),
        saved: z.boolean(),
        activated: z.boolean(),
        granted: z.boolean(),
      })
      .nullable(),
  })
  .openapi("WorkflowReviewReceipt");
export type WorkflowReviewReceipt = z.infer<typeof WorkflowReviewReceiptSchema>;
