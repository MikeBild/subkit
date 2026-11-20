import { z } from "@hono/zod-openapi";
import {
  getTask,
  TASK_USAGE_ATTRIBUTIONS,
  TASK_USAGE_NOT_INCLUDED,
  TASK_USAGE_PERIODS,
  type TaskUsage,
  taskUsage,
} from "../../tasks/index.ts";
import { now } from "../../utils/clock.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, isRejection, reject } from "./index.ts";
import { TASK_CODES, TaskFailures, taskPrincipal } from "./tasks.ts";

const TaskUsagePeriodSchema = z
  .object({
    period: z.enum(TASK_USAGE_PERIODS),
    task_run_id: z.string().uuid().nullable(),
    attribution: z.enum(TASK_USAGE_ATTRIBUTIONS),
    not_included: z.array(z.enum(TASK_USAGE_NOT_INCLUDED)),
    calls: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    cost: z
      .object({
        amount: z.number(),
        currency: z.string(),
        unpriced_models: z.array(z.string()),
      })
      .nullable(),
  })
  .openapi("TaskUsagePeriod");

const TaskUsageResponse = z
  .object({ last_run: TaskUsagePeriodSchema, current_month: TaskUsagePeriodSchema })
  .openapi("TaskUsageResponse");

interface TaskUsageResult {
  readonly last_run: TaskUsage;
  readonly current_month: TaskUsage;
}

export const getTaskUsageOperation = defineOperation<{ id: string }, TaskUsageResult>({
  id: "task.usage",
  summary:
    "Model usage of a task: its latest run and the current month, as calls, tokens and priced cost",
  permission: "task:read",
  resource: { type: "task", param: "id" },
  effect: "read",
  async handler(scope, { id }) {
    const principal = taskPrincipal(scope);
    if (isRejection(principal)) return principal;
    const task = await getTask(
      { tenant_id: scope.tenant_id, principal, task_id: id, include_archived: true },
      scope.db,
    );
    if (!task) return reject.status(404, TASK_CODES.not_found, "task not found");
    const at = new Date(now());
    const [last_run, current_month] = await Promise.all([
      taskUsage(scope.db, scope.tenant_id, id, "last_run", at),
      taskUsage(scope.db, scope.tenant_id, id, "current_month", at),
    ]);
    return { last_run, current_month };
  },
  http: {
    method: "get",
    path: "/v1/tasks/{id}/usage",
    tags: ["tasks"],
    params: IdParam,
    response: TaskUsageResponse,
    errors: { 404: TaskFailures[404] },
    toInput: ({ param }) => ({ id: (param as { id: string }).id }),
    toBody: (usage) => usage,
  },
});
