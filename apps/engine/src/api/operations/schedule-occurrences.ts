import { z } from "@hono/zod-openapi";
import { SCHEDULE_OCCURRENCE_STATES, type ScheduleOccurrenceRow } from "../../db/schema/index.ts";
import {
  listScheduleOccurrences,
  SCHEDULE_OCCURRENCE_PAGE_MAX,
} from "../../scheduler/schedule-occurrences.ts";
import { getTask } from "../../tasks/index.ts";
import { getWorkflow } from "../../workflows/service.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, isRejection, reject } from "./index.ts";
import { TASK_CODES, TaskFailures, taskPrincipal } from "./tasks.ts";

export const SCHEDULE_OCCURRENCE_DEFAULT_LIMIT = 50;

export const ScheduleOccurrenceSchema = z
  .object({
    id: z.string().uuid(),
    workflow_id: z.string().uuid().nullable(),
    task_id: z.string().uuid().nullable(),
    schedule_id: z.string().uuid().nullable(),
    due_at: z.string().datetime().describe("The first due time this row stands for."),
    last_due_at: z
      .string()
      .datetime()
      .describe("The newest due time this row stands for; equals due_at for a single occurrence."),
    started_at: z
      .string()
      .datetime()
      .nullable()
      .describe("When the run started; null unless it ran."),
    state: z
      .enum(SCHEDULE_OCCURRENCE_STATES)
      .describe(
        "ran: started near its due time. ran_late: started late or stood in for missed occurrences. skipped: deliberately not started. held: could not start until a person acts.",
      ),
    reason_code: z
      .string()
      .nullable()
      .describe(
        "Why: late_start, merged_missed, calendar_weekend, calendar_skip_date, failure_backoff, repeated_failures, input_required, execution_authority_required, execution_authority_unavailable, or a task admission reason such as grant_required, grant_expired, previous_run_active. Null for a run on time.",
      ),
    skipped_count: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Due occurrences without a run of their own: for skipped and held rows every occurrence the row stands for, for ran_late the earlier occurrences this run stood in for.",
      ),
    execution_id: z.string().uuid().nullable(),
    task_run_id: z.string().uuid().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi("ScheduleOccurrence");

const ScheduleOccurrenceListQuery = z
  .object({
    limit: z.coerce.number().int().positive().max(SCHEDULE_OCCURRENCE_PAGE_MAX).optional(),
    before: z
      .string()
      .datetime()
      .optional()
      .describe("Only occurrences due before this instant; pass next_before to read on."),
  })
  .openapi("ListScheduleOccurrencesQuery");

const ScheduleOccurrenceListResponse = z
  .object({
    items: z.array(ScheduleOccurrenceSchema),
    next_before: z
      .string()
      .datetime()
      .nullable()
      .describe("Pass as before to read older occurrences; null when this page is the last."),
  })
  .openapi("ScheduleOccurrenceListResponse");

type OccurrencePage = z.infer<typeof ScheduleOccurrenceListResponse>;

interface OccurrenceListInput {
  id: string;
  limit: number;
  before?: Date;
}

export function scheduleOccurrencePage(
  rows: readonly ScheduleOccurrenceRow[],
  limit: number,
): OccurrencePage {
  const items = rows.slice(0, limit).map((row) => ({
    id: row.id,
    workflow_id: row.workflow_id,
    task_id: row.task_id,
    schedule_id: row.schedule_id,
    due_at: row.due_at.toISOString(),
    last_due_at: row.last_due_at.toISOString(),
    started_at: row.started_at?.toISOString() ?? null,
    state: row.state,
    reason_code: row.reason_code,
    skipped_count: row.skipped_count,
    execution_id: row.execution_id,
    task_run_id: row.task_run_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }));
  const last = items[items.length - 1];
  return { items, next_before: rows.length > limit && last ? last.due_at : null };
}

function listInput({ param, query }: { param: unknown; query: unknown }): OccurrenceListInput {
  const page = query as z.infer<typeof ScheduleOccurrenceListQuery>;
  return {
    id: (param as { id: string }).id,
    limit: page.limit ?? SCHEDULE_OCCURRENCE_DEFAULT_LIMIT,
    ...(page.before ? { before: new Date(page.before) } : {}),
  };
}

export const listWorkflowScheduleOccurrencesOperation = defineOperation<
  OccurrenceListInput,
  OccurrencePage
>({
  id: "workflow.schedule_occurrences",
  summary:
    "Schedule history of a workflow, newest first: which due runs ran, ran late, were skipped or held, and why",
  permission: "workflow:read",
  resource: { type: "workflow", param: "id" },
  effect: "read",
  async handler(scope, { id, limit, before }) {
    if (!(await getWorkflow(scope.tenant_id, id, scope.db))) return reject.notFound("workflow");
    const rows = await listScheduleOccurrences(
      scope.db,
      { tenant_id: scope.tenant_id, workflow_id: id },
      { limit: limit + 1, ...(before ? { before } : {}) },
    );
    return scheduleOccurrencePage(rows, limit);
  },
  http: {
    method: "get",
    path: "/v1/workflows/{id}/schedule-occurrences",
    tags: ["workflows"],
    params: IdParam,
    query: ScheduleOccurrenceListQuery,
    response: ScheduleOccurrenceListResponse,
    errors: { 404: "Workflow not found" },
    toInput: listInput,
    toBody: (page) => page,
  },
});

export const listTaskScheduleOccurrencesOperation = defineOperation<
  OccurrenceListInput,
  OccurrencePage
>({
  id: "task.schedule_occurrences",
  summary:
    "Schedule history of a task, newest first: which due starts ran, ran late, were skipped or held, and why",
  permission: "task:read",
  resource: { type: "task", param: "id" },
  effect: "read",
  async handler(scope, { id, limit, before }) {
    const principal = taskPrincipal(scope);
    if (isRejection(principal)) return principal;
    const task = await getTask(
      { tenant_id: scope.tenant_id, principal, task_id: id, include_archived: true },
      scope.db,
    );
    if (!task) return reject.status(404, TASK_CODES.not_found, "task not found");
    const rows = await listScheduleOccurrences(
      scope.db,
      { tenant_id: scope.tenant_id, task_id: id },
      { limit: limit + 1, ...(before ? { before } : {}) },
    );
    return scheduleOccurrencePage(rows, limit);
  },
  http: {
    method: "get",
    path: "/v1/tasks/{id}/schedule-occurrences",
    tags: ["tasks"],
    params: IdParam,
    query: ScheduleOccurrenceListQuery,
    response: ScheduleOccurrenceListResponse,
    errors: { 404: TaskFailures[404] },
    toInput: listInput,
    toBody: (page) => page,
  },
});
