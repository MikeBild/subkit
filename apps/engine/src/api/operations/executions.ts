import { z } from "@hono/zod-openapi";
import { executionStartTraceId } from "../../audit/execution-traces.ts";
import { KEYSET_CURSOR_PATTERN } from "../../db/keyset-cursor.ts";
import { EXECUTION_STATUSES } from "../../execution/core/status.ts";
import { describeExecutionEvidence } from "../../execution/evidence.ts";
import {
  type ExecutionListResult,
  type ExecutionRow,
  type ListExecutionsOptions,
  listExecutions,
} from "../../execution/list.ts";
import { loadExecutionOutcome } from "../../execution/outcome.ts";
import {
  listExecutionPage,
  listVisibleExecutionSteps,
  loadExecutionCost,
  loadExecutionDetail,
} from "../../execution/read-service.ts";
import { isSensitivePayload } from "../../execution/sensitive-payload.ts";
import { findVisibleExecution } from "../../execution/visible-reads.ts";
import {
  ExecDetailSchema,
  ExecListResponse,
  StepListResponse,
  serializeExec,
  serializeStep,
} from "../../http/routes/executions/schemas.ts";
import { IdParam } from "../common-schemas.ts";
import { ExecutionCost } from "./execution-cost-representation.ts";
import { defineOperation, isRejection, reject } from "./index.ts";

const ListExecutionsQuery = z
  .object({
    limit: z.coerce.number().int().positive().max(200).optional(),
    cursor: z
      .string()
      .max(128)
      .regex(KEYSET_CURSOR_PATTERN, "must be a cursor returned by next_cursor (<ts>|<uuid>)")
      .optional()
      .describe(
        "Opaque `next_cursor` of the previous page, passed back verbatim. Pages are newest first by (created_at, id) and stay stable while new runs arrive.",
      ),
    workflow_id: z.string().uuid().optional(),
    status: z
      .string()
      .optional()
      .describe(
        "One status, or several separated by commas (`failed,timed_out,aborted`); `total` then counts every run in any of them.",
      ),
    request_source: z.string().optional(),
    q: z.string().trim().min(1).max(200).optional(),
    started_from: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe(
        "Only runs that started at or after this instant (ISO 8601). The same field and bounds `GET /v1/stats/executions` counts on.",
      ),
    started_to: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("Only runs that started before this instant (ISO 8601, exclusive)."),
    held_effects: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional()
      .describe(
        "Filter by whether one or more steps were held. `true` returns only runs with held effects; `false` returns runs without them.",
      ),
    parent_execution_id: z.string().uuid().optional(),
  })
  .openapi("ListExecutionsQuery");

const ListExecutionsToolInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z
      .string()
      .min(1)
      .max(128)
      .regex(
        KEYSET_CURSOR_PATTERN,
        "Invalid cursor. Omit cursor for the first page; for later pages copy next_cursor from the previous result without changing it. Keep the same filters.",
      )
      .optional()
      .describe(
        "Omit for the first page. For later pages use only the previous result's non-null next_cursor verbatim, with unchanged filters. Never invent a cursor or use a page number.",
      ),
    workflow_id: z.string().uuid().optional(),
    status: z
      .enum(EXECUTION_STATUSES)
      .optional()
      .describe("Filter by outcome only when the task requires it; omit to inspect all outcomes."),
    request_source: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Filter by the run's recorded start channel only when requested, not the current chat channel.",
      ),
    started_from: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("Only runs that started at or after this instant (ISO 8601)."),
    started_to: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("Only runs that started before this instant (ISO 8601, exclusive)."),
  })
  .openapi("ListExecutionsToolInput");

const GetExecutionToolInput = z.object({ id: z.string().uuid() }).openapi("GetExecutionToolInput");

type ListQuery = z.infer<typeof ListExecutionsQuery>;
type ListToolArgs = z.infer<typeof ListExecutionsToolInput>;
type ExecutionPage = Awaited<ReturnType<typeof listExecutionPage>>;

interface ExecutionListInput {
  readonly options: Omit<ListExecutionsOptions, "principal">;
  readonly enrich: boolean;
}

type ExecutionListOutcome = ExecutionListResult & {
  readonly enrichment?: Pick<ExecutionPage, "workflow_names" | "failures" | "held_execution_ids">;
};

function listOptionsFromQuery(q: ListQuery): Omit<ListExecutionsOptions, "principal"> {
  return {
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
    ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
    ...(q.workflow_id !== undefined ? { workflow_id: q.workflow_id } : {}),
    ...(q.status !== undefined ? { status: q.status } : {}),
    ...(q.request_source !== undefined ? { request_source: q.request_source } : {}),
    ...(q.q !== undefined ? { q: q.q } : {}),
    ...(q.started_from !== undefined ? { started_from: new Date(q.started_from) } : {}),
    ...(q.started_to !== undefined ? { started_to: new Date(q.started_to) } : {}),
    ...(q.held_effects !== undefined ? { held_effects: q.held_effects } : {}),
    ...(q.parent_execution_id !== undefined ? { parent_execution_id: q.parent_execution_id } : {}),
  };
}

function listOptionsFromToolArgs(args: ListToolArgs): Omit<ListExecutionsOptions, "principal"> {
  return {
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
    ...(args.workflow_id !== undefined ? { workflow_id: args.workflow_id } : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
    ...(args.request_source !== undefined ? { request_source: args.request_source } : {}),
    ...(args.started_from !== undefined ? { started_from: new Date(args.started_from) } : {}),
    ...(args.started_to !== undefined ? { started_to: new Date(args.started_to) } : {}),
  };
}

function toolError(outcome: { code: string }) {
  return outcome.code === "unauthorized" ? "principal_required" : "execution_not_found";
}

export const listExecutionsOperation = defineOperation<ExecutionListInput, ExecutionListOutcome>({
  id: "executions.list",
  summary: "List executions",
  permission: "execution:read",
  effect: "read",
  async handler(scope, { options, enrich }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    if (!enrich) return listExecutions(scope.tenant_id, { principal, ...options }, scope.db);
    const { workflow_names, failures, held_execution_ids, ...page } = await listExecutionPage(
      scope.db,
      principal,
      options,
    );
    return { ...page, enrichment: { workflow_names, failures, held_execution_ids } };
  },
  http: {
    method: "get",
    path: "/v1/executions",
    tags: ["executions"],
    query: ListExecutionsQuery,
    response: ExecListResponse,
    toInput: ({ query }) => ({ options: listOptionsFromQuery(query as ListQuery), enrich: true }),
    toBody: ({ rows, total, next_cursor, enrichment }) => ({
      items: rows.map((r) => ({
        ...serializeExec(
          r,
          r.workflow_id ? (enrichment?.workflow_names.get(r.workflow_id) ?? null) : null,
        ),
        held_effects: enrichment?.held_execution_ids.has(r.id) ?? false,
        failure: enrichment?.failures.get(r.id) ?? null,
      })),
      total,
      next_cursor,
    }),
  },
  tool: {
    name: "list_executions",
    description:
      "List recent executions for the tenant (newest first, paged — executions are an unbounded history). Omit cursor on the first page. Use only filters justified by the task; do not invent status, channel or date bounds. When the user names a workflow, first resolve it with get_workflow/find_workflow and pass workflow_id; never treat the tenant-wide latest execution as evidence for a named workflow. started_from/started_to narrow to a window on the start time (the window `get_operating_figures` counts over), status to one outcome. `total` is the exact count under the given filters; while `has_more` is true, pass `next_cursor` back verbatim as `cursor` with unchanged filters for the next page. A failed read is missing evidence, not an empty history.",
    input: ListExecutionsToolInput,
    gate: "deferred",
    toInput: (raw) => ({ options: listOptionsFromToolArgs(raw as ListToolArgs), enrich: false }),
    toResult: (outcome) => {
      if (isRejection(outcome)) return { ok: false, data: { error: "principal_required" } };
      const { rows, total, next_cursor } = outcome;
      return {
        ok: true,
        data: {
          items: rows.map((e) => ({
            id: e.id,
            ...describeExecutionEvidence(e),
            workflow_id: e.workflow_id,
            status: e.status,
            started_at: e.started_at,
            finished_at: e.finished_at,
          })),
          total,
          returned: rows.length,
          next_cursor,
          has_more: next_cursor !== null,
        },
      };
    },
  },
});

interface ExecutionGetInput {
  readonly id: string;
  readonly with_workflow_name: boolean;
}

interface ExecutionGetResult {
  readonly row: ExecutionRow;
  readonly workflow_name: string | null;
  readonly outcome: Awaited<ReturnType<typeof loadExecutionOutcome>>;
  readonly trace_id: Awaited<ReturnType<typeof executionStartTraceId>>;
}

export const getExecutionOperation = defineOperation<ExecutionGetInput, ExecutionGetResult>({
  id: "executions.get",
  summary: "Get an execution",
  permission: "execution:read",
  resource: { type: "execution", param: "id" },
  effect: "read",
  async handler(scope, { id, with_workflow_name }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    if (with_workflow_name) {
      const detail = await loadExecutionDetail(scope.db, principal, id);
      return detail ?? reject.notFound("execution");
    }
    const row = await findVisibleExecution(scope.db, scope.tenant_id, id, principal);
    if (!row) return reject.notFound("execution");
    const trace_id = await executionStartTraceId(scope.db, scope.tenant_id, row.id);
    const outcome = await loadExecutionOutcome(scope.tenant_id, row, scope.db);
    return { row, workflow_name: null, outcome, trace_id };
  },
  http: {
    method: "get",
    path: "/v1/executions/{id}",
    tags: ["executions"],
    params: IdParam,
    response: ExecDetailSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => ({ id: (param as { id: string }).id, with_workflow_name: true }),
    toBody: ({ row, workflow_name, outcome, trace_id }) => ({
      ...serializeExec(row, workflow_name),
      outcome,
      trace_id,
    }),
  },
  tool: {
    name: "get_execution",
    description:
      "Fetch one execution by id (full row including status, timestamps and `caller`: who started it, how SubKit verified them, over which channel, and the originating run for nested runs) plus its structured `outcome`: kind (succeeded / failed / held = writes held in a preview, nothing written / partial = a tolerated step failure / running), the failed step, its cause class and error code, step counts, and the output-contract verdict.",
    input: GetExecutionToolInput,
    gate: "enforced",
    toInput: (raw) => ({ id: (raw as { id: string }).id, with_workflow_name: false }),
    toResult: (outcome) => {
      if (isRejection(outcome)) return { ok: false, data: { error: toolError(outcome) } };
      const { row: e, outcome: executionOutcome, trace_id } = outcome;
      return {
        ok: true,
        data: {
          execution: {
            id: e.id,
            ...describeExecutionEvidence(e),
            workflow_id: e.workflow_id,
            workflow_version_id: e.workflow_version_id,
            status: e.status,
            request_source: e.request_source,
            trace_id,
            parent_execution_id: e.parent_execution_id,
            input: isSensitivePayload(e.input) ? null : e.input,
            started_at: e.started_at,
            finished_at: e.finished_at,
            created_at: e.created_at,
          },
          outcome: executionOutcome,
        },
      };
    },
  },
});

export const listExecutionStepsOperation = defineOperation<
  { readonly id: string },
  NonNullable<Awaited<ReturnType<typeof listVisibleExecutionSteps>>>
>({
  id: "executions.steps",
  summary: "List steps for an execution",
  permission: "execution:read",
  resource: { type: "execution", param: "id" },
  effect: "read",
  async handler(scope, { id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    return (
      (await listVisibleExecutionSteps(scope.db, principal, id)) ?? reject.notFound("execution")
    );
  },
  http: {
    method: "get",
    path: "/v1/executions/{id}/steps",
    tags: ["executions"],
    params: IdParam,
    response: StepListResponse,
    errors: { 404: "Not found" },
    toInput: ({ param }) => ({ id: (param as { id: string }).id }),
    toBody: (rows) => ({ items: rows.map(serializeStep) }),
  },
});

export const getExecutionCostOperation = defineOperation<
  { readonly id: string },
  NonNullable<Awaited<ReturnType<typeof loadExecutionCost>>>
>({
  id: "executions.cost",
  summary: "Cost + token attribution for an execution",
  permission: "execution:read",
  resource: { type: "execution", param: "id" },
  effect: "read",
  async handler(scope, { id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    return (await loadExecutionCost(scope.db, principal, id)) ?? reject.notFound("execution");
  },
  http: {
    method: "get",
    path: "/v1/executions/{id}/cost",
    tags: ["executions"],
    params: IdParam,
    response: ExecutionCost,
    errors: { 404: "Not found" },
    toInput: ({ param }) => ({ id: (param as { id: string }).id }),
    toBody: (cost) => cost,
  },
});
