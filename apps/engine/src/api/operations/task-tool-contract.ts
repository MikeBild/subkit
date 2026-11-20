import { z } from "@hono/zod-openapi";

const Id = z.string().uuid();

export const TASK_TOOL_LIST_DEFAULT_LIMIT = 25;
export const TASK_TOOL_LIST_MAX_LIMIT = 100;
export const TASK_TOOL_FIND_MAX_LIMIT = 20;

export function taskCockpitPath(task_id: string): string {
  return `/cockpit/tasks/${task_id}`;
}

export const ListTasksToolInput = z
  .object({
    category: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .max(40)
      .optional()
      .describe("Only tasks in this catalog block."),
    lifecycle: z
      .enum(["active", "archived"])
      .optional()
      .describe("Defaults to active. Archived tasks are deleted tasks kept for their history."),
    limit: z.number().int().min(1).max(TASK_TOOL_LIST_MAX_LIMIT).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .openapi("ListTasksToolInput");

export const FindTaskToolInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("Words from the task name, goal or description."),
    limit: z.number().int().min(1).max(TASK_TOOL_FIND_MAX_LIMIT).optional(),
  })
  .openapi("FindTaskToolInput");

export const GetTaskToolInput = z.object({ id: Id }).openapi("GetTaskToolInput");

export const GetTaskRunToolInput = z.object({ id: Id }).openapi("GetTaskRunToolInput");

export const RunTaskToolInput = z
  .object({ task_id: Id.describe("The task to start, from list_tasks or find_task.") })
  .openapi("RunTaskToolInput");

export const AbortTaskRunToolInput = z
  .object({ task_run_id: Id.describe("The run to stop, from get_task or run_task.") })
  .openapi("AbortTaskRunToolInput");

export interface TaskToolContract {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodTypeAny;
  readonly category: "tenant_read" | "tenant_write";
  readonly permission: {
    readonly action: string;
    readonly resourceType: string;
    readonly resourceIdArg?: string;
  };
}

export const TASK_TOOL_CONTRACTS = {
  list_tasks: {
    name: "list_tasks",
    description:
      "List the tasks the current person may see, one page at a time, with schedule, pause state and `total`. Use it for an overview or when the person asks what tasks exist. A task is a goal with a plan that SubKit works through on its own; to search by words use `find_task`, and for saved workflows use `list_workflows`.",
    input: ListTasksToolInput,
    category: "tenant_read",
    permission: { action: "task:read", resourceType: "task" },
  },
  find_task: {
    name: "find_task",
    description:
      "Search tasks by words from their name, goal or description and return the best matches with their ids. Use it when the person refers to a task by name before calling `get_task`, `run_task` or `save_task`. It finds tasks only, never workflows or connectors.",
    input: FindTaskToolInput,
    category: "tenant_read",
    permission: { action: "task:read", resourceType: "task" },
  },
  get_task: {
    name: "get_task",
    description:
      "Read one task in full: goal, done-when, plan, bound workflows, connectors and skills, schedule, pause state, revision and its latest run. Use it before changing a task with `save_task` (it returns the `revision` to pass as `expected_revision`) or to answer how a task is set up. For the progress of a run use `get_task_run`.",
    input: GetTaskToolInput,
    category: "tenant_read",
    permission: { action: "task:read", resourceType: "task", resourceIdArg: "id" },
  },
  get_task_run: {
    name: "get_task_run",
    description:
      "Read one run of a task: state, waiting reason, turns used, deadline, failure code and the id of the conversation the run works in. Use it to report on a run started with `run_task` or found through `get_task`. It reads only; answering a question the run asked happens in the run's own conversation.",
    input: GetTaskRunToolInput,
    category: "tenant_read",
    permission: { action: "task_run:read", resourceType: "task_run", resourceIdArg: "id" },
  },
  run_task: {
    name: "run_task",
    description:
      "Start a run of a saved task now, as the current person. The run works in its own separate conversation; this call returns the run id, its state and the Cockpit path where the person can follow it, it does not wait for the result. Do not use it to run a single workflow (`run_workflow`) or while the task already has a run in progress.",
    input: RunTaskToolInput,
    category: "tenant_write",
    permission: { action: "task:run", resourceType: "task", resourceIdArg: "task_id" },
  },
  abort_task_run: {
    name: "abort_task_run",
    description:
      "Stop a run of a task that is still running, waiting or sleeping. Use it only when the person asks to stop that run; a stopped run cannot be continued, a new one is started with `run_task`. To keep a task from starting on its schedule, pause the task in the Cockpit instead.",
    input: AbortTaskRunToolInput,
    category: "tenant_write",
    permission: {
      action: "task_run:abort",
      resourceType: "task_run",
      resourceIdArg: "task_run_id",
    },
  },
} as const satisfies Record<string, TaskToolContract>;

export const SAVE_TASK_TOOL_NAME = "save_task";

export const SAVE_TASK_TOOL_DESCRIPTION =
  "Create a task, or update one when `task_id` is given, so SubKit can work through a goal on its own later. Use it when the person wants the work of this conversation repeated or scheduled: give the goal, when it counts as done, the workflows, connectors and skills it may use and an optional schedule; the plan is taken from this conversation's playbook unless `plan` is passed. It only stores the task: it starts no run and grants no standing permission, the person does that in the Cockpit. Do not use it to save a workflow (`save_workflow_draft`).";
