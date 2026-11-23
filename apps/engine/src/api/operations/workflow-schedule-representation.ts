import { z } from "@hono/zod-openapi";
import { AUTHORITY_REFUSAL_CODES } from "@shared/authority-refusal.ts";
import { COST_PROJECTION_BASES, COST_PROJECTION_STATES } from "../../scheduler/cost-projection.ts";

const ScheduleAdmissionHold = z
  .object({
    reason_code: z.enum([...AUTHORITY_REFUSAL_CODES, "input_required"]),
    observed_at: z.string().datetime(),
    refusals: z.number().int().positive().optional(),
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

export const ScheduleCostProjectionSchema = z
  .object({
    state: z
      .enum(COST_PROJECTION_STATES)
      .describe(
        "estimated: monthly_amount is set. no_history: neither this version nor another version of the workflow has a finished run yet. unknown_rhythm: the cron or interval cannot be counted.",
      ),
    basis: z
      .enum(COST_PROJECTION_BASES)
      .nullable()
      .describe(
        "version: averaged over finished runs of the current version. workflow: no run of the current version yet, averaged over finished runs of other versions.",
      ),
    runs_sampled: z
      .number()
      .int()
      .nonnegative()
      .describe("Finished runs the average per run is taken from (the most recent ones)."),
    runs_per_month: z
      .number()
      .nonnegative()
      .nullable()
      .describe("Runs a month from the cron or interval, averaged over the coming year."),
    per_run_amount: z.number().nonnegative().nullable(),
    monthly_amount: z.number().nonnegative().nullable(),
    currency: z.string(),
    unpriced_models: z
      .array(z.string())
      .describe("Models in the sampled runs without a price; the estimate leaves them out."),
    rates_basis: z.literal("current"),
  })
  .describe(
    "Projected model cost a month: the average priced model cost per finished run times runs a month. Prices are the current model rates.",
  )
  .openapi("ScheduleCostProjection");

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
    cost_projection: ScheduleCostProjectionSchema,
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
    execution_mode: z.enum(["dev", "prod"]).optional().openapi({
      description:
        "Environment the schedule runs in. Omitted on a new schedule: the creator's setup default, otherwise dev. Omitted on an existing schedule: its environment stays. A prod schedule still needs a prod approval.",
    }),
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

export const ScheduleCostQuery = z
  .object({
    cron: z.string().min(1).describe('5-field cron or "every:<seconds>".'),
    timezone: z.string().optional().describe("IANA timezone; UTC when omitted."),
  })
  .openapi("ScheduleCostQuery");

export const ScheduleDeleteResponse = z
  .object({ id: z.string(), deleted: z.boolean() })
  .openapi("ScheduleDeleteResponse");
