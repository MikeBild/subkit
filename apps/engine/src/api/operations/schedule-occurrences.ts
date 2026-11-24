import { z } from "@hono/zod-openapi";
import { SCHEDULE_OCCURRENCE_STATES, type ScheduleOccurrenceRow } from "../../db/schema/index.ts";
import {
  OCCURRENCE_RUN_OUTCOMES,
  type OccurrenceRunOutcome,
} from "../../scheduler/occurrence-outcome.ts";
import {
  listScheduleOccurrences,
  readOccurrenceRunOutcomes,
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
        "Why: late_start, merged_missed, calendar_weekend, calendar_skip_date, failure_backoff, repeated_failures, input_required, execution_authority_required, execution_authority_expired, execution_authority_exhausted, execution_authority_revoked, execution_authority_changed, or a task admission reason such as grant_required, grant_expired, previous_run_active. Null for a run on time.",
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
    run_outcome: z
      .enum(OCCURRENCE_RUN_OUTCOMES)
      .nullable()
      .describe(
        "What became of the run this occurrence started: running, succeeded, failed (failed or timed out) or aborted. Null when it started no run or the run is gone.",
      ),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi("ScheduleOccurrence");

const ScheduleOccurrenceListQuery = z
  .object({
    limit: z.coerce.number().int().positive().max(SCHEDULE_OCCURRENCE_PAGE_MAX).optional(),
    before: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("Only occurrences due before this instant; pass next_before to read on."),
    before_id: z
      .string()
      .uuid()
      .optional()
      .describe(
        "With before, read on after this occurrence, including later rows due at the same instant; pass next_before_id.",
      ),
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
    next_before_id: z
      .string()
      .uuid()
      .nullable()
      .describe("Pass as before_id together with next_before; null when this page is the last."),
  })
  .openapi("ScheduleOccurrenceListResponse");

type OccurrencePage = z.infer<typeof ScheduleOccurrenceListResponse>;

interface OccurrenceListInput {
  id: string;
  limit: number;
  before?: Date;
  beforeId?: string;
}

export function scheduleOccurrencePage(
  rows: readonly ScheduleOccurrenceRow[],
  limit: number,
  outcomes: ReadonlyMap<string, OccurrenceRunOutcome | null> = new Map(),
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
    run_outcome: outcomes.get(row.id) ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }));
  const last = rows.length > limit ? items[items.length - 1] : undefined;
  return { items, next_before: last?.due_at ?? null, next_before_id: last?.id ?? null };
}

function listInput({ param, query }: { param: unknown; query: unknown }): OccurrenceListInput {
  const page = query as z.infer<typeof ScheduleOccurrenceListQuery>;
  return {
    id: (param as { id: string }).id,
    limit: page.limit ?? SCHEDULE_OCCURRENCE_DEFAULT_LIMIT,
    ...(page.before ? { before: new Date(page.before) } : {}),
    ...(page.before && page.before_id ? { beforeId: page.before_id } : {}),
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
  async handler(scope, { id, limit, before, beforeId }) {
    if (!(await getWorkflow(scope.tenant_id, id, scope.db))) return reject.notFound("workflow");
    const rows = await listScheduleOccurrences(
      scope.db,
      { tenant_id: scope.tenant_id, workflow_id: id },
      { limit: limit + 1, ...(before ? { before } : {}), ...(beforeId ? { beforeId } : {}) },
    );
    return scheduleOccurrencePage(
      rows,
      limit,
      await readOccurrenceRunOutcomes(scope.db, scope.tenant_id, rows.slice(0, limit)),
    );
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
  async handler(scope, { id, limit, before, beforeId }) {
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
      { limit: limit + 1, ...(before ? { before } : {}), ...(beforeId ? { beforeId } : {}) },
    );
    return scheduleOccurrencePage(
      rows,
      limit,
      await readOccurrenceRunOutcomes(scope.db, scope.tenant_id, rows.slice(0, limit)),
    );
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
