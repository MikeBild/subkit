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
    input: z
      .unknown()
      .nullable()
      .describe(
        "Persisted workflow input returned verbatim to workflow readers; credentials belong in connector credential storage.",
      ),
    created_at: z.string(),
  })
  .openapi("ScheduleEntry");
