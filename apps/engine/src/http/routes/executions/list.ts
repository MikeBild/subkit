import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { executionStartTraceId, readRequestSource } from "../../../audit/index.ts";
import { KEYSET_CURSOR_PATTERN } from "../../../db/keyset-cursor.ts";
import { events, executionSteps, executions, workflows } from "../../../db/schema/index.ts";
import {
  authorizeSensitiveResume,
  executionVisibilityFilter,
  executionVisibleToPrincipal,
  isSensitivePayload,
  listExecutions,
  loadExecutionOutcome,
  loadFailureSummaries,
  recoverExecutionPayload,
} from "../../../execution/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { streamOutboxTail } from "../sse-outbox-tail.ts";
import { admissionRefusal } from "./admission-errors.ts";
import {
  ExecDetailSchema,
  ExecListResponse,
  StepListResponse,
  serializeExec,
  serializeStep,
} from "./schemas.ts";

const listExecutionsRoute = createRoute({
  method: "get",
  path: "/v1/executions",
  tags: ["executions"],
  summary: "List executions",
  security: [{ bearerAuth: [] }],
  request: {
    query: z
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
      .openapi("ListExecutionsQuery"),
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ExecListResponse } } },
  },
});

const getExecutionRoute = createRoute({
  method: "get",
  path: "/v1/executions/{id}",
  tags: ["executions"],
  summary: "Get an execution",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ExecDetailSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getStepsRoute = createRoute({
  method: "get",
  path: "/v1/executions/{id}/steps",
  tags: ["executions"],
  summary: "List steps for an execution",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: StepListResponse } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getSensitiveResultRoute = createRoute({
  method: "get",
  path: "/v1/executions/{id}/result",
  tags: ["executions"],
  summary: "Get the result of a sensitive execution for its original caller",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ result: z.unknown() }) } },
    },
    403: {
      description: "The authenticated caller does not match the original sensitive execution",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerListRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/executions/:id", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "GET") {
      return requirePermission("execution:read", () => ({ type: "execution", id }))(c, next);
    }
    return next();
  });
  app.use("/v1/executions/:id/steps", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("execution:read", () => ({ type: "execution", id }))(c, next);
  });
  app.use("/v1/executions/:id/stream", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("execution:read", () => ({ type: "execution", id }))(c, next);
  });
  app.use("/v1/executions/:id/result", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("execution:read", () => ({ type: "execution", id }))(c, next);
  });

  app.openapi(listExecutionsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const { rows, total, next_cursor } = await listExecutions(
      principal.tenant_id,
      {
        principal,
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
        ...(q.workflow_id !== undefined ? { workflow_id: q.workflow_id } : {}),
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.request_source !== undefined ? { request_source: q.request_source } : {}),
        ...(q.q !== undefined ? { q: q.q } : {}),
        ...(q.started_from !== undefined ? { started_from: new Date(q.started_from) } : {}),
        ...(q.started_to !== undefined ? { started_to: new Date(q.started_to) } : {}),
        ...(q.held_effects !== undefined ? { held_effects: q.held_effects } : {}),
        ...(q.parent_execution_id !== undefined
          ? { parent_execution_id: q.parent_execution_id }
          : {}),
      },
      db,
    );
    const ids = [...new Set(rows.map((r) => r.workflow_id).filter((v): v is string => v !== null))];
    const heldCandidates = rows.filter((r) => r.status === "succeeded");
    const [named, failures, heldSteps] = await Promise.all([
      ids.length
        ? db
            .select({ id: workflows.id, name: workflows.name })
            .from(workflows)
            .where(and(eq(workflows.tenant_id, principal.tenant_id), inArray(workflows.id, ids)))
        : Promise.resolve([]),
      loadFailureSummaries(principal.tenant_id, rows, db),
      heldCandidates.length
        ? db
            .selectDistinct({ execution_id: executionSteps.execution_id })
            .from(executionSteps)
            .where(
              and(
                eq(executionSteps.tenant_id, principal.tenant_id),
                inArray(
                  executionSteps.execution_id,
                  heldCandidates.map((r) => r.id),
                ),
                or(
                  eq(executionSteps.held, true),
                  sql`${executionSteps.request_meta}->'extras'->>'held' = 'true'`,
                ),
              ),
            )
        : Promise.resolve([]),
    ]);
    const nameById = new Map(named.map((w) => [w.id, w.name]));
    const heldExecutionIds = new Set(heldSteps.map((step) => step.execution_id));
    return c.json(
      {
        items: rows.map((r) => ({
          ...serializeExec(r, r.workflow_id ? (nameById.get(r.workflow_id) ?? null) : null),
          held_effects: heldExecutionIds.has(r.id),
          failure: failures.get(r.id) ?? null,
        })),
        total,
        next_cursor,
      },
      200,
    );
  });

  app.openapi(getExecutionRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const rows = await db
      .select()
      .from(executions)
      .where(and(eq(executions.tenant_id, principal.tenant_id), eq(executions.id, id)))
      .limit(1);
    const row = rows[0];
    if (!row || !executionVisibleToPrincipal(row.caller_context, principal))
      throw new NotFoundError("execution");
    const [named, outcome, traceId] = await Promise.all([
      row.workflow_id
        ? db
            .select({ name: workflows.name })
            .from(workflows)
            .where(
              and(eq(workflows.tenant_id, principal.tenant_id), eq(workflows.id, row.workflow_id)),
            )
            .limit(1)
        : Promise.resolve([]),
      loadExecutionOutcome(principal.tenant_id, row, db),
      executionStartTraceId(db, principal.tenant_id, row.id),
    ]);
    return c.json(
      { ...serializeExec(row, named[0]?.name ?? null), outcome, trace_id: traceId },
      200,
    );
  });

  app.openapi(getStepsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const visible = await db
      .select({ id: executions.id })
      .from(executions)
      .where(
        and(
          eq(executions.tenant_id, principal.tenant_id),
          eq(executions.id, id),
          executionVisibilityFilter(principal),
        ),
      )
      .limit(1);
    if (!visible[0]) throw new NotFoundError("execution");
    const rows = await db
      .select()
      .from(executionSteps)
      .where(
        and(eq(executionSteps.tenant_id, principal.tenant_id), eq(executionSteps.execution_id, id)),
      )
      .orderBy(asc(executionSteps.started_at));
    return c.json({ items: rows.map(serializeStep) }, 200);
  });

  app.openapi(getSensitiveResultRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const row = (
      await db
        .select()
        .from(executions)
        .where(
          and(
            eq(executions.tenant_id, principal.tenant_id),
            eq(executions.id, id),
            executionVisibilityFilter(principal),
          ),
        )
        .limit(1)
    )[0];
    if (
      !row ||
      row.status !== "succeeded" ||
      !isSensitivePayload(row.input) ||
      !isSensitivePayload(row.sensitive_result)
    )
      throw new NotFoundError("execution_result");
    try {
      await authorizeSensitiveResume(db, row, principal);
    } catch (error) {
      return admissionRefusal(error, {
        db,
        principal,
        workflow_id: row.workflow_id,
        request_source: readRequestSource(c) ?? "api",
        execution_id: row.id,
      });
    }
    return c.json(
      {
        result: recoverExecutionPayload(
          row.sensitive_result,
          principal.tenant_id,
          row.id,
          "result",
        ),
      },
      200,
    );
  });

  app.get("/v1/executions/:id/stream", async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const id = c.req.param("id");
    const found = await db
      .select({ id: executions.id })
      .from(executions)
      .where(
        and(
          eq(executions.tenant_id, principal.tenant_id),
          eq(executions.id, id),
          executionVisibilityFilter(principal),
        ),
      )
      .limit(1);
    if (!found[0]) throw new NotFoundError("execution");
    return streamOutboxTail(c, {
      db,
      replay: "all",
      conds: () => [
        eq(events.tenant_id, principal.tenant_id),
        eq(events.channel, "execution.status"),
        sql`${events.payload}->>'execution_id' = ${id}`,
      ],
      closeAfter: (row) => TERMINAL_EXECUTION_EVENTS.has(row.type),
    });
  });
}

const TERMINAL_EXECUTION_EVENTS = new Set([
  "execution.succeeded",
  "execution.failed",
  "execution.refused",
  "execution.aborted",
  "execution.timed_out",
]);
