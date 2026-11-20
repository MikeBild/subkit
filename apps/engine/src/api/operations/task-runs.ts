import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { errorFields, logger } from "../../logging/logger.ts";
import {
  abortTaskRun,
  completeTaskRun,
  countTaskRuns,
  getTask,
  getTaskRun,
  listTaskRuns,
  rejectTaskRunResult,
  type StartTaskRunResult,
  startTaskRun,
  type TaskAdmissionReason,
  type TaskRun,
  TaskRunSchema,
  taskServiceDeps,
} from "../../tasks/index.ts";
import {
  readTaskRunPendingQuestion,
  type TaskRunDetail,
  TaskRunDetailSchema,
} from "../../tasks/run-question.ts";
import { requireHumanSession } from "../../workflows/execution-authorities.ts";
import { IdParam, paginatedResponse } from "../common-schemas.ts";
import {
  defineOperation,
  isRejection,
  type OperationScope,
  type Rejection,
  reject,
} from "./index.ts";
import { TASK_TOOL_CONTRACTS, taskCockpitPath } from "./task-tool-contract.ts";
import {
  TASK_CODES,
  TaskFailures,
  type TaskRejectionCodes,
  taskPrincipal,
  taskRejection,
  taskToolFailure,
} from "./tasks.ts";

const LIST_DEFAULT_LIMIT = 50;

const RUN_CODES: TaskRejectionCodes = {
  not_found: "task_run_not_found",
  conflict: "task_run_ended",
};

const RESULT_CODES: TaskRejectionCodes = {
  not_found: "task_run_not_found",
  conflict: "task_run_not_result_ready",
};

const ADMISSION_MESSAGES: Readonly<Record<TaskAdmissionReason | "run_ended", string>> = {
  grant_required: "This task has no standing permission yet.",
  grant_expired: "The standing permission of this task has expired.",
  grant_exhausted: "The standing permission of this task has no runs left.",
  grant_fingerprint_mismatch: "The task changed after its standing permission was given.",
  owner_unavailable: "The owner of this task is not available or may not run tasks.",
  ai_access_missing: "AI access is not set up for this workspace.",
  previous_run_active: "This task already has a run in progress.",
  paused: "This task is paused. Resume it before starting a run.",
  run_ended: "The run ended while it was starting.",
};

const RunFailures = {
  403: TaskFailures[403],
  404: "Task run not found or not visible to the caller",
  409: "The run is not in a state that allows this",
} as const;

const TaskRunListQuery = z
  .object({
    limit: z.coerce.number().int().positive().max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .openapi("ListTaskRunsQuery");

const TaskRunListResponse = paginatedResponse(TaskRunSchema, "TaskRunListResponse").extend({
  total: z.number().int().nonnegative(),
});

interface IdInput {
  readonly id: string;
}

function idFrom(param: unknown): IdInput {
  return { id: (param as IdInput).id };
}

function runNotFound(): Rejection {
  return reject.status(404, RUN_CODES.not_found, "task run not found");
}

function admissionRejection(outcome: Exclude<StartTaskRunResult, { admitted: true }>): Rejection {
  return reject.status(
    409,
    outcome.reason,
    ADMISSION_MESSAGES[outcome.reason],
    "run" in outcome
      ? {
          task_run_id: outcome.run.id,
          state: outcome.run.state,
          failure_code: outcome.run.failure_code,
        }
      : undefined,
  );
}

function runSource(scope: OperationScope): "api" | "chat" {
  return scope.request ? "api" : "chat";
}

async function enqueueTurn(scope: OperationScope, run: TaskRun): Promise<void> {
  await taskServiceDeps().enqueueRunTurn(scope.db, {
    tenant_id: scope.tenant_id,
    task_id: run.task_id,
    task_run_id: run.id,
  });
}

async function settleResult(
  scope: OperationScope,
  principal: ResolvedPrincipal,
  run: TaskRun,
  confirmed: boolean,
): Promise<void> {
  await import("../../tasks/run-driver.ts")
    .then((driver) =>
      driver.settleTaskRunResultConfirmation(scope.db, {
        tenant_id: scope.tenant_id,
        task_run_id: run.id,
        principal,
        confirmed,
      }),
    )
    .catch(() => false)
    .then((settled) => {
      if (!settled)
        logger.info({
          module: "tasks",
          action: "task_run.result_question_not_settled",
          msg: "the result decision is recorded on the run; no open result question was answered in the conversation",
          tenant_id: scope.tenant_id,
          task_run_id: run.id,
          confirmed,
        });
    });
}

const HUMAN_SESSION_REFUSALS = new Set([
  "human_session_required",
  "human_session_expired",
  "csrf_rejected",
]);

async function personInBrowser(scope: OperationScope): Promise<ResolvedPrincipal | Rejection> {
  const principal = taskPrincipal(scope);
  if (isRejection(principal)) return principal;
  const required = reject.status(
    403,
    "human_session_required",
    "a signed human browser session is required",
  );
  if (!scope.request || principal.provider === "task" || principal.auth_source?.kind === "task_run")
    return required;
  try {
    await requireHumanSession({ request: scope.request, principal });
    return principal;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== "string" || !HUMAN_SESSION_REFUSALS.has(code)) throw error;
    return code === "human_session_required"
      ? required
      : reject.status(403, code, (error as Error).message);
  }
}

async function enqueueFirstTurn(
  scope: OperationScope,
  principal: ResolvedPrincipal,
  run: TaskRun,
): Promise<void> {
  try {
    await enqueueTurn(scope, run);
  } catch (error) {
    await abortTaskRun(
      { tenant_id: scope.tenant_id, principal, task_run_id: run.id },
      scope.db,
    ).catch(() => undefined);
    throw error;
  }
}

function runToolData(run: TaskRun) {
  return {
    task_run_id: run.id,
    task_id: run.task_id,
    state: run.state,
    conversation_id: run.conversation_id,
    cockpit_path: taskCockpitPath(run.task_id),
  };
}

export const startTaskRunOperation = defineOperation<IdInput, TaskRun>({
  id: "task_run.start",
  summary:
    "Start a manual run of a task as the calling person; the run works in its own conversation",
  permission: "task:run",
  resource: { type: "task", param: "id" },
  effect: "write",
  audit: AuditAction.TASK_RUN_STARTED,
  async handler(scope, { id }) {
    const principal = taskPrincipal(scope);
    if (isRejection(principal)) return principal;
    let outcome: StartTaskRunResult;
    try {
      outcome = await startTaskRun(
        {
          tenant_id: scope.tenant_id,
          task_id: id,
          trigger: "manual",
          started_by: principal,
          source: runSource(scope),
        },
        scope.db,
      );
    } catch (error) {
      return taskRejection(error, TASK_CODES);
    }
    if (!outcome.admitted) return admissionRejection(outcome);
    await enqueueFirstTurn(scope, principal, outcome.run);
    return outcome.run;
  },
  http: {
    method: "post",
    path: "/v1/tasks/{id}/runs",
    tags: ["tasks"],
    params: IdParam,
    response: TaskRunSchema,
    success: { status: 201, description: "Run started; follow it through its conversation_id" },
    errors: {
      400: TaskFailures[400],
      404: TaskFailures[404],
      409: "The run was not admitted; the code names the reason",
    },
    toInput: ({ param }) => idFrom(param),
    toBody: (run) => run,
  },
  tool: {
    name: TASK_TOOL_CONTRACTS.run_task.name,
    description: TASK_TOOL_CONTRACTS.run_task.description,
    input: TASK_TOOL_CONTRACTS.run_task.input,
    gate: "enforced",
    permission: { resourceType: "task", resourceIdArg: "task_id" },
    toInput: (raw) => ({ id: (raw as { task_id: string }).task_id }),
    toResult: (outcome) => {
      if (isRejection(outcome)) return taskToolFailure(outcome);
      return {
        ok: true,
        data: {
          ...runToolData(outcome),
          note: "The run continues in its own conversation. Point the person to cockpit_path; read progress with get_task_run.",
        },
      };
    },
  },
});

interface RunListInput extends IdInput {
  readonly limit: number;
  readonly offset: number;
}

interface RunListResult {
  readonly items: TaskRun[];
  readonly total: number;
}

export const listTaskRunsOperation = defineOperation<RunListInput, RunListResult>({
  id: "task_run.list",
  summary: "List the runs of a task, newest first",
  permission: "task_run:read",
  effect: "read",
  async handler(scope, { id, limit, offset }) {
    const principal = taskPrincipal(scope);
    if (isRejection(principal)) return principal;
    const ref = { tenant_id: scope.tenant_id, principal, task_id: id };
    if (!(await getTask({ ...ref, include_archived: true }, scope.db)))
      return reject.status(404, TASK_CODES.not_found, "task not found");
    const [items, total] = await Promise.all([
      listTaskRuns({ ...ref, limit, offset }, scope.db),
      countTaskRuns(ref, scope.db),
    ]);
    return { items, total };
  },
  http: {
    method: "get",
    path: "/v1/tasks/{id}/runs",
    tags: ["tasks"],
    params: IdParam,
    query: TaskRunListQuery,
    response: TaskRunListResponse,
    errors: { 404: TaskFailures[404] },
    toInput: ({ param, query }) => {
      const page = query as z.infer<typeof TaskRunListQuery>;
      return {
        ...idFrom(param),
        limit: page.limit ?? LIST_DEFAULT_LIMIT,
        offset: page.offset ?? 0,
      };
    },
    toBody: ({ items, total }) => ({ items, total }),
  },
});

export const getTaskRunOperation = defineOperation<IdInput, TaskRunDetail>({
  id: "task_run.get",
  summary: "Fetch a task run with the conversation it works in",
  permission: "task_run:read",
  resource: { type: "task_run", param: "id" },
  effect: "read",
  async handler(scope, { id }) {
    const principal = taskPrincipal(scope);
    if (isRejection(principal)) return principal;
    const run = await getTaskRun(
      { tenant_id: scope.tenant_id, principal, task_run_id: id },
      scope.db,
    );
    if (!run) return runNotFound();
    const pending_question = await readTaskRunPendingQuestion(scope.db, scope.tenant_id, run);
    return { ...run, pending_question };
  },
  http: {
    method: "get",
    path: "/v1/task-runs/{id}",
    tags: ["tasks"],
    params: IdParam,
    response: TaskRunDetailSchema,
    errors: { 404: RunFailures[404] },
    toInput: ({ param }) => idFrom(param),
    toBody: (run) => run,
  },
  tool: {
    name: TASK_TOOL_CONTRACTS.get_task_run.name,
    description: TASK_TOOL_CONTRACTS.get_task_run.description,
    input: TASK_TOOL_CONTRACTS.get_task_run.input,
    gate: "enforced",
    toInput: (raw) => idFrom(raw),
    toResult: (outcome) => {
      if (isRejection(outcome)) return taskToolFailure(outcome);
      return {
        ok: true,
        data: { run: outcome, cockpit_path: taskCockpitPath(outcome.task_id) },
      };
    },
  },
});

export const abortTaskRunOperation = defineOperation<IdInput, TaskRun>({
  id: "task_run.abort",
  summary: "Stop a run that is running, waiting or sleeping",
  permission: "task_run:abort",
  resource: { type: "task_run", param: "id" },
  effect: "write",
  audit: AuditAction.TASK_RUN_ABORTED,
  async handler(scope, { id }) {
    const principal = taskPrincipal(scope);
    if (isRejection(principal)) return principal;
    try {
      return await abortTaskRun(
        { tenant_id: scope.tenant_id, principal, task_run_id: id },
        scope.db,
      );
    } catch (error) {
      return taskRejection(error, RUN_CODES);
    }
  },
  http: {
    method: "post",
    path: "/v1/task-runs/{id}/abort",
    tags: ["tasks"],
    params: IdParam,
    response: TaskRunSchema,
    errors: { 404: RunFailures[404], 409: "The run has already ended" },
    toInput: ({ param }) => idFrom(param),
    toBody: (run) => run,
  },
  tool: {
    name: TASK_TOOL_CONTRACTS.abort_task_run.name,
    description: TASK_TOOL_CONTRACTS.abort_task_run.description,
    input: TASK_TOOL_CONTRACTS.abort_task_run.input,
    gate: "enforced",
    permission: { resourceType: "task_run", resourceIdArg: "task_run_id" },
    toInput: (raw) => ({ id: (raw as { task_run_id: string }).task_run_id }),
    toResult: (outcome) => {
      if (isRejection(outcome)) return taskToolFailure(outcome);
      return { ok: true, data: runToolData(outcome) };
    },
  },
});

export const completeTaskRunOperation = defineOperation<IdInput, TaskRun>({
  id: "task_run.complete",
  summary: "Confirm the result of a run as the calling person",
  permission: "task:run",
  effect: "write",
  audit: AuditAction.TASK_RUN_COMPLETED,
  async handler(scope, { id }) {
    const principal = await personInBrowser(scope);
    if (isRejection(principal)) return principal;
    try {
      const run = await completeTaskRun(
        { tenant_id: scope.tenant_id, principal, task_run_id: id },
        scope.db,
      );
      await settleResult(scope, principal, run, true);
      return run;
    } catch (error) {
      return taskRejection(error, RESULT_CODES);
    }
  },
  http: {
    method: "post",
    path: "/v1/task-runs/{id}/complete",
    tags: ["tasks"],
    params: IdParam,
    response: TaskRunSchema,
    errors: RunFailures,
    toInput: ({ param }) => idFrom(param),
    toBody: (run) => run,
  },
});

export const rejectTaskRunResultOperation = defineOperation<IdInput, TaskRun>({
  id: "task_run.reject",
  summary: "Reject the result of a run as the calling person; the run continues working",
  permission: "task:run",
  effect: "write",
  audit: AuditAction.TASK_RUN_RESUMED,
  async handler(scope, { id }) {
    const principal = await personInBrowser(scope);
    if (isRejection(principal)) return principal;
    try {
      const { run, enqueue } = await rejectTaskRunResult(
        { tenant_id: scope.tenant_id, principal, task_run_id: id, source: runSource(scope) },
        scope.db,
      );
      await settleResult(scope, principal, run, false);
      if (enqueue)
        await enqueueTurn(scope, run).catch((error: unknown) => {
          logger.warn({
            module: "tasks",
            action: "task_run.continuation_not_queued",
            msg: "the result was rejected, but the next turn was not queued; the sweep continues the run",
            tenant_id: scope.tenant_id,
            task_run_id: run.id,
            ...errorFields(error),
          });
        });
      return run;
    } catch (error) {
      return taskRejection(error, RESULT_CODES);
    }
  },
  http: {
    method: "post",
    path: "/v1/task-runs/{id}/reject",
    tags: ["tasks"],
    params: IdParam,
    response: TaskRunSchema,
    errors: RunFailures,
    toInput: ({ param }) => idFrom(param),
    toBody: (run) => run,
  },
});
