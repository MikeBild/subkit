import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { ToolResult } from "../../conversations/tools/index.ts";
import { HttpError } from "../../http/errors.ts";
import { conversationLocale } from "../../http/routes/conversations/locale.ts";
import {
  countTasks,
  createTask,
  deleteTask,
  getTask,
  type ListTasksParams,
  listTasks,
  pauseTask,
  resumeTask,
  type Task,
  type TaskCreateInput,
  TaskCreateInputSchema,
  TaskLifecycleSchema,
  TaskRunSchema,
  TaskSchema,
  type TaskUpdateInput,
  TaskUpdateInputSchema,
  updateTask,
} from "../../tasks/index.ts";
import { type TaskView, TaskViewSchema, withTaskListView } from "../../tasks/list-view.ts";
import { now } from "../../utils/clock.ts";
import { CategoryFilterSchema } from "../catalog-metadata.ts";
import { IdParam, paginatedResponse } from "../common-schemas.ts";
import {
  defineOperation,
  isRejection,
  type OperationScope,
  type Rejection,
  reject,
} from "./index.ts";
import {
  TASK_TOOL_CONTRACTS,
  TASK_TOOL_FIND_MAX_LIMIT,
  TASK_TOOL_LIST_DEFAULT_LIMIT,
  taskCockpitPath,
} from "./task-tool-contract.ts";

const LIST_DEFAULT_LIMIT = 50;

const FORBIDDEN_MESSAGES: Readonly<Record<string, string>> = {
  task_owner_must_be_a_person: "Only a person can own a task.",
  task_run_confirmation_needs_a_person: "Only a person can confirm or reject a result.",
  task_principal_required: "This action needs a signed-in person or key.",
};

export interface TaskRejectionCodes {
  readonly not_found: string;
  readonly conflict: string;
}

export const TASK_CODES: TaskRejectionCodes = {
  not_found: "task_not_found",
  conflict: "task_revision_conflict",
};

export function taskRejection(error: unknown, codes: TaskRejectionCodes): Rejection {
  if (!(error instanceof HttpError)) throw error;
  const detail = typeof error.details?.code === "string" ? error.details.code : null;
  if (error.status === 404) {
    const resource = codes.not_found === "task_run_not_found" ? "task run" : "task";
    return reject.status(404, codes.not_found, `${resource} not found`);
  }
  if (error.status === 400)
    return reject.status(400, detail ?? "bad_request", error.message, error.details);
  if (error.status === 409)
    return reject.status(409, detail ?? codes.conflict, error.message, error.details);
  if (error.status === 403) {
    const message = FORBIDDEN_MESSAGES[error.message];
    return message
      ? reject.status(403, error.message, message)
      : reject.status(403, "forbidden", error.message);
  }
  throw error;
}

export function taskPrincipal(scope: OperationScope): ResolvedPrincipal | Rejection {
  return scope.principal ?? reject.unauthorized();
}

function taskLocale(scope: OperationScope): "de" | "en" | undefined {
  if (scope.locale) return scope.locale;
  const headers = scope.request?.headers;
  return headers
    ? conversationLocale(
        headers.get("cookie") ?? undefined,
        headers.get("accept-language") ?? undefined,
      )
    : undefined;
}

export function taskToolFailure(outcome: Rejection): ToolResult {
  return {
    ok: false,
    error_code: outcome.code,
    message: outcome.message,
    ...(outcome.details ? { details: outcome.details } : {}),
  };
}

export const TaskFailures = {
  400: "The request is not valid for this task",
  403: "The caller may not do this",
  404: "Task not found or not visible to the caller",
  409: "The task is not in a state that allows this",
} as const;

const TaskListQuery = z
  .object({
    lifecycle: TaskLifecycleSchema.optional(),
    owner_id: z.string().uuid().optional(),
    category: CategoryFilterSchema.optional(),
    q: z.string().min(1).max(200).optional(),
    sort: z.enum(["name", "updated_at", "created_at"]).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .openapi("ListTasksQuery");

const TaskListResponse = paginatedResponse(TaskViewSchema, "TaskListResponse").extend({
  total: z.number().int().nonnegative(),
});

const TaskUpdateResponse = TaskSchema.extend({
  schedule_changed: z.boolean(),
  grant_invalidated: z.boolean(),
  aborted_run_id: z.string().uuid().nullable(),
}).openapi("TaskUpdateResponse");

const TaskResumeResponse = TaskSchema.extend({
  run: z.union([TaskRunSchema, z.null()]),
}).openapi("TaskResumeResponse");

const TaskDeleteResponse = z
  .object({ id: z.string().uuid(), deleted: z.literal(true) })
  .openapi("TaskDeleteResponse");

type ListQuery = z.infer<typeof TaskListQuery>;
type TaskListInput = Omit<ListTasksParams, "tenant_id" | "principal">;

interface TaskListResult {
  readonly items: TaskView[];
  readonly total: number;
}

interface TaskIdInput {
  readonly id: string;
}

function idFrom(param: unknown): TaskIdInput {
  return { id: (param as TaskIdInput).id };
}

function listInputFromQuery(q: ListQuery): TaskListInput {
  return {
    ...(q.lifecycle ? { lifecycle: q.lifecycle } : {}),
    ...(q.owner_id ? { owner_id: q.owner_id } : {}),
    ...(q.category ? { category: q.category } : {}),
    ...(q.q ? { q: q.q } : {}),
    ...(q.sort ? { sort: q.sort } : {}),
    ...(q.order ? { order: q.order } : {}),
    limit: q.limit ?? LIST_DEFAULT_LIMIT,
    offset: q.offset ?? 0,
  };
}

function taskSummary(task: TaskView) {
  return {
    id: task.id,
    name: task.name,
    description: task.description,
    category: task.category,
    goal: task.goal,
    environment: task.environment,
    schedule_cron: task.schedule_cron,
    schedule_timezone: task.schedule_timezone,
    schedule_run_at: task.schedule_run_at,
    paused: task.paused_at !== null,
    paused_reason: task.paused_reason,
    lifecycle: task.lifecycle,
    revision: task.revision,
    updated_at: task.updated_at,
    latest_run: task.latest_run,
    grant_live: task.grant_live,
    next_start_at: task.next_start_at,
    cockpit_path: taskCockpitPath(task.id),
  };
}

async function listVisibleTasks(
  scope: OperationScope,
  input: TaskListInput,
): Promise<TaskListResult | Rejection> {
  const principal = taskPrincipal(scope);
  if (isRejection(principal)) return principal;
  const params = { tenant_id: scope.tenant_id, principal, ...input };
  const [items, total] = await Promise.all([
    listTasks(params, scope.db),
    countTasks(params, scope.db),
  ]);
  return {
    items: await withTaskListView(scope.db, scope.tenant_id, items, new Date(now())),
    total,
  };
}

export const listTasksOperation = defineOperation<TaskListInput, TaskListResult>({
  id: "task.list",
  summary: "List tasks; a person sees their own tasks, an admin sees all",
  permission: "task:read",
  effect: "read",
  handler: listVisibleTasks,
  http: {
    method: "get",
    path: "/v1/tasks",
    tags: ["tasks"],
    query: TaskListQuery,
    response: TaskListResponse,
    toInput: ({ query }) => listInputFromQuery(query as ListQuery),
    toBody: ({ items, total }) => ({ items, total }),
  },
  tool: {
    name: TASK_TOOL_CONTRACTS.list_tasks.name,
    description: TASK_TOOL_CONTRACTS.list_tasks.description,
    input: TASK_TOOL_CONTRACTS.list_tasks.input,
    gate: "enforced",
    toInput: (raw) => {
      const args = raw as z.infer<typeof TASK_TOOL_CONTRACTS.list_tasks.input>;
      return {
        ...(args.category ? { category: args.category } : {}),
        ...(args.lifecycle ? { lifecycle: args.lifecycle } : {}),
        sort: "name",
        order: "asc",
        limit: args.limit ?? TASK_TOOL_LIST_DEFAULT_LIMIT,
        offset: args.offset ?? 0,
      };
    },
    toResult: (outcome, input) => {
      if (isRejection(outcome)) return taskToolFailure(outcome);
      const offset = input.offset ?? 0;
      const has_more = offset + outcome.items.length < outcome.total;
      return {
        ok: true,
        data: {
          total: outcome.total,
          limit: input.limit ?? TASK_TOOL_LIST_DEFAULT_LIMIT,
          offset,
          has_more,
          ...(has_more ? { next_offset: offset + outcome.items.length } : {}),
          tasks: outcome.items.map(taskSummary),
        },
      };
    },
  },
});

export const findTaskOperation = defineOperation<TaskListInput, TaskListResult>({
  id: "task.find",
  summary: "Search tasks by name, goal or description",
  permission: "task:read",
  effect: "read",
  handler: listVisibleTasks,
  tool: {
    name: TASK_TOOL_CONTRACTS.find_task.name,
    description: TASK_TOOL_CONTRACTS.find_task.description,
    input: TASK_TOOL_CONTRACTS.find_task.input,
    gate: "enforced",
    toInput: (raw) => {
      const args = raw as z.infer<typeof TASK_TOOL_CONTRACTS.find_task.input>;
      return {
        q: args.query,
        sort: "name",
        order: "asc",
        limit: args.limit ?? TASK_TOOL_FIND_MAX_LIMIT,
        offset: 0,
      };
    },
    toResult: (outcome, input) => {
      if (isRejection(outcome)) return taskToolFailure(outcome);
      return {
        ok: true,
        data: {
          query: input.q ?? "",
          total: outcome.total,
          returned: outcome.items.length,
          tasks: outcome.items.map(taskSummary),
        },
      };
    },
  },
});

export const getTaskOperation = defineOperation<TaskIdInput, TaskView>({
  id: "task.get",
  summary: "Fetch a task with its latest run, standing permission state and next start",
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
    const [view] = await withTaskListView(scope.db, scope.tenant_id, [task], new Date(now()));
    return view ?? reject.status(404, TASK_CODES.not_found, "task not found");
  },
  http: {
    method: "get",
    path: "/v1/tasks/{id}",
    tags: ["tasks"],
    params: IdParam,
    response: TaskViewSchema,
    errors: { 404: TaskFailures[404] },
    toInput: ({ param }) => idFrom(param),
    toBody: (task) => task,
  },
  tool: {
    name: TASK_TOOL_CONTRACTS.get_task.name,
    description: TASK_TOOL_CONTRACTS.get_task.description,
    input: TASK_TOOL_CONTRACTS.get_task.input,
    gate: "enforced",
    toInput: (raw) => idFrom(raw),
    toResult: (outcome) => {
      if (isRejection(outcome)) return taskToolFailure(outcome);
      return {
        ok: true,
        data: { task: outcome, cockpit_path: taskCockpitPath(outcome.id) },
      };
    },
  },
});

export const createTaskOperation = defineOperation<TaskCreateInput, Task>({
  id: "task.create",
  summary: "Create a task owned by the calling person",
  permission: "task:write",
  effect: "write",
  audit: AuditAction.TASK_CREATED,
  async handler(scope, input) {
    const principal = taskPrincipal(scope);
    if (isRejection(principal)) return principal;
    try {
      return await createTask(
        { tenant_id: scope.tenant_id, principal, input, locale: taskLocale(scope) },
        scope.db,
      );
    } catch (error) {
      return taskRejection(error, TASK_CODES);
    }
  },
  http: {
    method: "post",
    path: "/v1/tasks",
    tags: ["tasks"],
    body: TaskCreateInputSchema,
    response: TaskSchema,
    success: { status: 201, description: "Created" },
    errors: { 400: TaskFailures[400], 403: TaskFailures[403] },
    toInput: ({ json }) => json as TaskCreateInput,
    toBody: (task) => task,
  },
});

interface TaskUpdateOperationInput extends TaskIdInput {
  readonly input: TaskUpdateInput;
}

type TaskUpdateResult = z.infer<typeof TaskUpdateResponse>;

export const updateTaskOperation = defineOperation<TaskUpdateOperationInput, TaskUpdateResult>({
  id: "task.update",
  summary:
    "Replace a task's definition; a content change stops its open run and ends its standing permission",
  permission: "task:write",
  resource: { type: "task", param: "id" },
  effect: "write",
  audit: AuditAction.TASK_UPDATED,
  async handler(scope, { id, input }) {
    const principal = taskPrincipal(scope);
    if (isRejection(principal)) return principal;
    try {
      const { task, ...changes } = await updateTask(
        { tenant_id: scope.tenant_id, principal, task_id: id, input, locale: taskLocale(scope) },
        scope.db,
      );
      return { ...task, ...changes };
    } catch (error) {
      return taskRejection(error, TASK_CODES);
    }
  },
  http: {
    method: "put",
    path: "/v1/tasks/{id}",
    tags: ["tasks"],
    params: IdParam,
    body: TaskUpdateInputSchema,
    response: TaskUpdateResponse,
    errors: { 400: TaskFailures[400], 404: TaskFailures[404], 409: "The task changed meanwhile" },
    toInput: ({ param, json }) => ({ ...idFrom(param), input: json as TaskUpdateInput }),
    toBody: (result) => result,
  },
});

export const deleteTaskOperation = defineOperation<TaskIdInput, { id: string; deleted: true }>({
  id: "task.delete",
  summary: "Delete a task: it is archived, its open run stops and its standing permission ends",
  permission: "task:delete",
  resource: { type: "task", param: "id" },
  effect: "write",
  audit: AuditAction.TASK_DELETED,
  async handler(scope, { id }) {
    const principal = taskPrincipal(scope);
    if (isRejection(principal)) return principal;
    try {
      await deleteTask({ tenant_id: scope.tenant_id, principal, task_id: id }, scope.db);
      return { id, deleted: true };
    } catch (error) {
      return taskRejection(error, TASK_CODES);
    }
  },
  http: {
    method: "delete",
    path: "/v1/tasks/{id}",
    tags: ["tasks"],
    params: IdParam,
    response: TaskDeleteResponse,
    errors: { 404: TaskFailures[404] },
    toInput: ({ param }) => idFrom(param),
    toBody: (result) => result,
  },
});

export const pauseTaskOperation = defineOperation<TaskIdInput, Task>({
  id: "task.pause",
  summary: "Pause a task: no run starts and an open run sleeps until the task is resumed",
  permission: "task:pause",
  resource: { type: "task", param: "id" },
  effect: "write",
  audit: AuditAction.TASK_PAUSED,
  async handler(scope, { id }) {
    const principal = taskPrincipal(scope);
    if (isRejection(principal)) return principal;
    try {
      return await pauseTask({ tenant_id: scope.tenant_id, principal, task_id: id }, scope.db);
    } catch (error) {
      return taskRejection(error, TASK_CODES);
    }
  },
  http: {
    method: "post",
    path: "/v1/tasks/{id}/pause",
    tags: ["tasks"],
    params: IdParam,
    response: TaskSchema,
    errors: { 404: TaskFailures[404] },
    toInput: ({ param }) => idFrom(param),
    toBody: (task) => task,
  },
});

type TaskResumeResult = z.infer<typeof TaskResumeResponse>;

export const resumeTaskOperation = defineOperation<TaskIdInput, TaskResumeResult>({
  id: "task.resume",
  summary: "Resume a paused task; a run that slept through the pause continues",
  permission: "task:resume",
  resource: { type: "task", param: "id" },
  effect: "write",
  audit: AuditAction.TASK_RESUMED,
  async handler(scope, { id }) {
    const principal = taskPrincipal(scope);
    if (isRejection(principal)) return principal;
    try {
      const { task, run } = await resumeTask(
        { tenant_id: scope.tenant_id, principal, task_id: id },
        scope.db,
      );
      return { ...task, run };
    } catch (error) {
      return taskRejection(error, TASK_CODES);
    }
  },
  http: {
    method: "post",
    path: "/v1/tasks/{id}/resume",
    tags: ["tasks"],
    params: IdParam,
    response: TaskResumeResponse,
    errors: { 404: TaskFailures[404] },
    toInput: ({ param }) => idFrom(param),
    toBody: (result) => result,
  },
});
