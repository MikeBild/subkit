import { z } from "@hono/zod-openapi";

const ScheduleAdmissionHold = z
  .object({
    reason_code: z.enum([
      "execution_authority_required",
      "execution_authority_unavailable",
      "input_required",
    ]),
    observed_at: z.string().datetime(),
  })
  .nullable();

const ScheduleInputError = z
  .object({
    checked_version_id: z.string().uuid(),
    issues: z.array(z.object({ path: z.string(), message: z.string() })).min(1),
  })
  .nullable();

export const AutomationReadinessSchema = z
  .object({
    environment: z.enum(["dev", "prod"]),
    workflow_version_id: z.string().nullable(),
    state: z.enum(["eligible", "repair_required", "verification_unavailable"]),
    issues: z.array(z.object({ step_id: z.string(), code: z.string() })),
    repair_guidance: z.array(
      z.object({ step_id: z.string(), code: z.string(), instruction: z.string() }),
    ),
  })
  .describe(
    "Whether recurring runs of the saved version can be approved. repair_required means no human approval can unblock it: change the named steps as repair_guidance says.",
  )
  .openapi("AutomationReadiness");

export const ScheduleEntry = z
  .object({
    id: z.string(),
    workflow_id: z.string(),
    admission_hold: ScheduleAdmissionHold,
    input_error: ScheduleInputError,
    workflow_slug: z.string().nullable(),
    workflow_name: z.string().nullable(),
    prepared_version_id: z.string().nullable(),
    cron: z.string(),
    timezone: z.string(),
    execution_mode: z.enum(["dev", "prod"]),
    paused: z.boolean(),
    auto_pause: z
      .object({
        paused_reason: z.literal("repeated_failures"),
        failure_class: z.string(),
        consecutive_failures: z.number().int().positive(),
        since: z.string().datetime(),
      })
      .nullable()
      .describe(
        "Set when the engine paused this schedule itself after the same failure repeated; null for a schedule a person paused or one that runs. Resuming (paused: false) clears it and starts counting failures afresh.",
      ),
    input: z
      .unknown()
      .nullable()
      .describe(
        "Persisted workflow input returned verbatim to workflow readers; credentials belong in connector credential storage.",
      ),
    created_at: z.string(),
  })
  .openapi("ScheduleEntry");

export const ScheduleUpsertResponse = ScheduleEntry.extend({
  upsert_status: z.enum(["created", "updated"]),
  automation_readiness: AutomationReadinessSchema.optional(),
}).openapi("ScheduleUpsertResponse");

export const ScheduleWriteResponse = ScheduleEntry.extend({
  automation_readiness: AutomationReadinessSchema.optional(),
}).openapi("ScheduleWriteResponse");

const ScheduleInputSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

export const ScheduleListResponse = z
  .object({
    schedules: z.array(ScheduleEntry),
    total: z.number().int().nonnegative(),
  })
  .openapi("ScheduleListResponse");

export const ScheduleCreateBody = z
  .object({
    workflow_id: z.string().uuid(),
    cron: z.string().min(1),
    timezone: z.string().optional(),
    execution_mode: z.enum(["dev", "prod"]).optional(),
    paused: z.boolean().optional(),
    input: ScheduleInputSchema.optional(),
  })
  .openapi("ScheduleCreateBody");

export const ScheduleUpdateBody = z
  .object({
    cron: z.string().min(1).optional(),
    timezone: z.string().optional(),
    execution_mode: z.enum(["dev", "prod"]).optional(),
    paused: z.boolean().optional(),
    input: ScheduleInputSchema.optional(),
  })
  .openapi("ScheduleUpdateBody");

export const ScheduleDeleteResponse = z
  .object({ id: z.string(), deleted: z.boolean() })
  .openapi("ScheduleDeleteResponse");
