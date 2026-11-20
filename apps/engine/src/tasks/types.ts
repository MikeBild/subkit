import { z } from "@hono/zod-openapi";
import { PlaybookPlanSchema } from "../conversations/public/authoring.ts";
import { WorkflowEffectManifestSchema } from "../workflows/effect-manifest.ts";
import { TASK_RUN_FAILURE_CODES } from "./core/failure-codes.ts";

const Id = z.string().uuid();
const Timestamp = z.string().datetime({ offset: true });
const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const PlanText = z.string().trim().min(1).max(600);

function distinct(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export const TASK_ENVIRONMENTS = ["dev", "prod"] as const;
export const TASK_LIFECYCLES = ["active", "archived"] as const;
export const TASK_PAUSED_REASONS = ["owner_request", "admin", "owner_unavailable"] as const;
export const TASK_RUN_TRIGGERS = ["manual", "once", "cron"] as const;
export const TASK_RUN_STATES = [
  "running",
  "waiting",
  "sleeping",
  "result_ready",
  "completed",
  "aborted",
  "failed",
] as const;
export const TASK_RUN_OPEN_STATES = ["running", "waiting", "sleeping"] as const;
export const TASK_RUN_WAITING_REASONS = [
  "question",
  "approval",
  "no_progress",
  "budget",
  "question_expired",
  "ai_access",
  "turn_stopped",
] as const;
export const TASK_ADMISSION_REASONS = [
  "grant_required",
  "grant_expired",
  "grant_exhausted",
  "grant_fingerprint_mismatch",
  "owner_unavailable",
  "ai_access_missing",
  "previous_run_active",
  "paused",
] as const;
export const TASK_GRANT_BLOCK_REASONS = [
  "workflow_missing",
  "workflow_not_active",
  "workflow_sensitive",
  "workflow_not_repeatable",
] as const;

export const TaskEnvironmentSchema = z.enum(TASK_ENVIRONMENTS);
export const TaskLifecycleSchema = z.enum(TASK_LIFECYCLES);
export const TaskPausedReasonSchema = z.enum(TASK_PAUSED_REASONS);
export const TaskRunTriggerSchema = z.enum(TASK_RUN_TRIGGERS);
export const TaskRunStateSchema = z.enum(TASK_RUN_STATES);
export const TaskRunWaitingReasonSchema = z.enum(TASK_RUN_WAITING_REASONS);
export const TaskAdmissionReasonSchema = z.enum(TASK_ADMISSION_REASONS);
export const TaskRunFailureCodeSchema = z.enum(TASK_RUN_FAILURE_CODES);
export const TaskGrantBlockReasonSchema = z.enum(TASK_GRANT_BLOCK_REASONS);

export type TaskEnvironment = z.infer<typeof TaskEnvironmentSchema>;
export type TaskLifecycle = z.infer<typeof TaskLifecycleSchema>;
export type TaskPausedReason = z.infer<typeof TaskPausedReasonSchema>;
export type TaskRunTrigger = z.infer<typeof TaskRunTriggerSchema>;
export type TaskRunState = z.infer<typeof TaskRunStateSchema>;
export type TaskRunWaitingReason = z.infer<typeof TaskRunWaitingReasonSchema>;
export type TaskAdmissionReason = z.infer<typeof TaskAdmissionReasonSchema>;
export type TaskGrantBlockReason = z.infer<typeof TaskGrantBlockReasonSchema>;

export const TaskBindingsSchema = z
  .object({
    workflow_ids: z.array(Id).max(20).refine(distinct, "workflow_ids must be distinct"),
    connector_ids: z.array(Id).max(20).refine(distinct, "connector_ids must be distinct"),
    skill_slugs: z
      .array(z.string().trim().min(1).max(200))
      .max(20)
      .refine(distinct, "skill_slugs must be distinct"),
    web_search: z.boolean(),
  })
  .strict()
  .openapi("TaskBindings");

export type TaskBindings = z.infer<typeof TaskBindingsSchema>;

export const TaskPlanSchema = PlaybookPlanSchema.openapi("TaskPlan");

export type TaskPlan = z.infer<typeof TaskPlanSchema>;

const scheduleFields = {
  schedule_cron: z.string().trim().min(1).max(120).nullable(),
  schedule_timezone: z.string().trim().min(1).max(64).nullable(),
  schedule_run_at: Timestamp.nullable(),
};

function scheduleIsExclusive(value: {
  schedule_cron?: string | null;
  schedule_run_at?: string | null;
}): boolean {
  return value.schedule_cron == null || value.schedule_run_at == null;
}

const SCHEDULE_EXCLUSIVE = {
  message: "A task repeats on a cron schedule or runs once at a set time, not both.",
  path: ["schedule_run_at"],
};

export const TaskScheduleSchema = z
  .object(scheduleFields)
  .strict()
  .refine(scheduleIsExclusive, SCHEDULE_EXCLUSIVE)
  .openapi("TaskSchedule");

export type TaskSchedule = z.infer<typeof TaskScheduleSchema>;

const definitionFields = {
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().default(null),
  category: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(40)
    .optional(),
  goal: PlanText,
  done_when: z.string().trim().min(1).max(2000),
  plan: TaskPlanSchema,
  bindings: TaskBindingsSchema,
  environment: TaskEnvironmentSchema,
  schedule_cron: scheduleFields.schedule_cron.default(null),
  schedule_timezone: scheduleFields.schedule_timezone.default(null),
  schedule_run_at: scheduleFields.schedule_run_at.default(null),
  max_turns: z.number().int().min(1).max(100).default(10),
  run_deadline_minutes: z.number().int().min(5).max(10080).default(240),
};

export const TaskCreateInputSchema = z
  .object({
    ...definitionFields,
    environment: TaskEnvironmentSchema.optional().describe(
      "Where bound workflows run. Left out: the calling person's default environment from their setup, or dev when they chose none.",
    ),
  })
  .strict()
  .refine(scheduleIsExclusive, SCHEDULE_EXCLUSIVE)
  .openapi("TaskCreateInput");

export const TaskUpdateInputSchema = z
  .object({ ...definitionFields, expected_revision: z.number().int().min(1) })
  .strict()
  .refine(scheduleIsExclusive, SCHEDULE_EXCLUSIVE)
  .openapi("TaskUpdateInput");

export type TaskCreateRequest = z.infer<typeof TaskCreateInputSchema>;
export type TaskCreateInput = TaskCreateRequest & { environment: TaskEnvironment };
export type TaskUpdateInput = z.infer<typeof TaskUpdateInputSchema>;

export const TaskSchema = z
  .object({
    id: Id,
    name: z.string(),
    description: z.string().nullable(),
    category: z.string(),
    owner_id: Id,
    goal: z.string(),
    done_when: z.string(),
    plan: TaskPlanSchema,
    bindings: TaskBindingsSchema,
    environment: TaskEnvironmentSchema,
    schedule_cron: z.string().nullable(),
    schedule_timezone: z.string().nullable(),
    schedule_run_at: Timestamp.nullable(),
    last_claimed_at: Timestamp.nullable(),
    paused_at: Timestamp.nullable(),
    paused_by: Id.nullable(),
    paused_reason: TaskPausedReasonSchema.nullable(),
    max_turns: z.number().int(),
    run_deadline_minutes: z.number().int(),
    fingerprint: Fingerprint,
    revision: z.number().int(),
    lifecycle: TaskLifecycleSchema,
    created_at: Timestamp,
    updated_at: Timestamp,
  })
  .openapi("Task");

export type Task = z.infer<typeof TaskSchema>;

export const TaskRunSchema = z
  .object({
    id: Id,
    task_id: Id,
    task_revision: z.number().int(),
    fingerprint: Fingerprint,
    conversation_id: Id.nullable(),
    trigger: TaskRunTriggerSchema,
    started_by: Id.nullable(),
    grant_id: Id.nullable(),
    state: TaskRunStateSchema,
    waiting_reason: TaskRunWaitingReasonSchema.nullable(),
    next_check_at: Timestamp.nullable(),
    sleep_reason: z.string().max(200).nullable(),
    deadline_at: Timestamp,
    turns_used: z.number().int(),
    no_progress_count: z.number().int(),
    last_seen_turn_id: Id.nullable(),
    last_playbook_revision: z.number().int(),
    trace_id: z.string().regex(/^[0-9a-f]{32}$/),
    failure_code: TaskRunFailureCodeSchema.nullable(),
    result_ready_at: Timestamp.nullable(),
    completed_at: Timestamp.nullable(),
    completed_by: Id.nullable(),
    ended_at: Timestamp.nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
  })
  .openapi("TaskRun");

export type TaskRun = z.infer<typeof TaskRunSchema>;

export const TaskGrantSchema = z
  .object({
    id: Id,
    task_id: Id,
    fingerprint: Fingerprint,
    environment: TaskEnvironmentSchema,
    valid_from: Timestamp,
    valid_until: Timestamp.nullable(),
    max_runs: z.number().int().nullable(),
    reserved_runs: z.number().int(),
    created_by: Id,
    created_at: Timestamp,
    revoked_at: Timestamp.nullable(),
    revoked_by: Id.nullable(),
    workflow_authority_ids: z.array(Id),
  })
  .openapi("TaskGrant");

export type TaskGrant = z.infer<typeof TaskGrantSchema>;

export const TaskGrantInputSchema = z
  .object({
    expected_fingerprint: Fingerprint,
    valid_until: Timestamp.nullable(),
    max_runs: z.number().int().min(1).nullable(),
  })
  .strict()
  .openapi("TaskGrantInput");

export type TaskGrantInput = z.infer<typeof TaskGrantInputSchema>;

export const TaskGrantPreviewSchema = z
  .object({
    task_id: Id,
    fingerprint: Fingerprint,
    environment: TaskEnvironmentSchema,
    grantable: z.boolean(),
    workflows: z.array(
      z.object({
        workflow_id: Id,
        workflow_version_id: Id.nullable(),
        name: z.string().nullable(),
        effect_manifest_digest: Fingerprint.nullable(),
        effect_manifest: WorkflowEffectManifestSchema.nullable(),
        blocked_reason: TaskGrantBlockReasonSchema.nullable(),
      }),
    ),
  })
  .openapi("TaskGrantPreview");

export type TaskGrantPreview = z.infer<typeof TaskGrantPreviewSchema>;

export const TaskRunMarkerSchema = z
  .object({
    task_id: Id,
    task_run_id: Id,
    environment: TaskEnvironmentSchema,
    workflow_ids: z.array(Id),
    connector_ids: z.array(Id),
    web_search: z.boolean(),
  })
  .strict();

export type TaskRunMarker = z.infer<typeof TaskRunMarkerSchema>;

export { TASK_RUN_FAILURE_CODES, type TaskRunFailureCode } from "./core/failure-codes.ts";
