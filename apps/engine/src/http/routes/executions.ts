// Execution list / get / steps / cancel.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, desc, eq } from "drizzle-orm";
import { ErrorSchema, IdParam, paginatedResponse } from "../../api/common-schemas.ts";
import { writeEvent } from "../../db/events.ts";
import { executionSteps, executions } from "../../db/schema/index.ts";
import { cancel as abortCancel, getAbort } from "../../execution/abort.ts";
import { logger } from "../../logging/logger.ts";
import { EXECUTION_RUN_QUEUE } from "../../queue/queues.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const ExecSchema = z
  .object({
    id: z.string(),
    workflow_id: z.string(),
    workflow_version_id: z.string(),
    status: z.string(),
    request_source: z.string(),
    parent_execution_id: z.string().nullable(),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("Execution");

const ExecListResponse = paginatedResponse(ExecSchema, "ExecutionListResponse");

const StepRowSchema = z
  .object({
    id: z.string(),
    step_key: z.string(),
    step_index: z.number().nullable(),
    kind: z.string(),
    status: z.string(),
    duration_ms: z.number().nullable(),
    retry_count: z.number(),
    result_storage_uri: z.string().nullable(),
    result_preview: z.string().nullable(),
    output_preview: z.unknown().nullable(),
    error: z.unknown().nullable(),
    request_meta: z.unknown().nullable(),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
  })
  .openapi("ExecutionStep");

const StepListResponse = paginatedResponse(StepRowSchema, "ExecutionStepListResponse");

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
        workflow_id: z.string().uuid().optional(),
        status: z.string().optional(),
        request_source: z.string().optional(),
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
    200: { description: "OK", content: { "application/json": { schema: ExecSchema } } },
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

const cancelRoute = createRoute({
  method: "post",
  path: "/v1/executions/{id}/cancel",
  tags: ["executions"],
  summary: "Cancel an in-flight execution",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    202: { description: "Cancellation requested" },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

function serializeExec(row: typeof executions.$inferSelect) {
  return {
    id: row.id,
    workflow_id: row.workflow_id,
    workflow_version_id: row.workflow_version_id,
    status: row.status,
    request_source: row.request_source,
    parent_execution_id: row.parent_execution_id ?? null,
    started_at: row.started_at ? row.started_at.toISOString() : null,
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
  };
}

function serializeStep(row: typeof executionSteps.$inferSelect) {
  return {
    id: row.id,
    step_key: row.step_key,
    step_index: row.step_index ?? null,
    kind: row.kind,
    status: row.status,
    duration_ms: row.duration_ms ?? null,
    retry_count: row.retry_count ?? 0,
    result_storage_uri: row.result_storage_uri ?? null,
    result_preview: row.result_preview ?? null,
    output_preview: row.output_preview ?? null,
    error: row.error ?? null,
    request_meta: row.request_meta ?? null,
    started_at: row.started_at ? row.started_at.toISOString() : null,
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
  };
}

export function registerExecutionRoutes(app: OpenAPIHono<AppEnv>): void {
  // RBAC: execution reads go through `execution:read`; cancel goes
  // through `execution:abort`. The SSE stream is also read-only.
  app.use("/v1/executions", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("execution:read")(c, next);
    return next();
  });
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
  app.use("/v1/executions/:id/cancel", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("execution:abort", () => ({ type: "execution", id }))(c, next);
  });
  app.use("/v1/executions/:id/stream", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("execution:read", () => ({ type: "execution", id }))(c, next);
  });

  app.openapi(listExecutionsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const conds = [eq(executions.tenant_id, principal.tenant_id)];
    if (q.workflow_id) conds.push(eq(executions.workflow_id, q.workflow_id));
    if (q.status)
      conds.push(eq(executions.status, q.status as typeof executions.$inferSelect.status));
    if (q.request_source) conds.push(eq(executions.request_source, q.request_source));
    const rows = await db
      .select()
      .from(executions)
      .where(and(...conds))
      .orderBy(desc(executions.created_at))
      .limit(q.limit ?? 50);
    return c.json({ items: rows.map(serializeExec) }, 200);
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
    if (!row) throw new NotFoundError("execution");
    return c.json(serializeExec(row), 200);
  });

  app.openapi(getStepsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const rows = await db
      .select()
      .from(executionSteps)
      .where(
        and(eq(executionSteps.tenant_id, principal.tenant_id), eq(executionSteps.execution_id, id)),
      )
      .orderBy(asc(executionSteps.started_at));
    return c.json({ items: rows.map(serializeStep) }, 200);
  });

  app.openapi(cancelRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const rows = await db
      .select()
      .from(executions)
      .where(and(eq(executions.tenant_id, principal.tenant_id), eq(executions.id, id)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError("execution");

    // (a) If the execution is still queued, mark the pg-boss job
    // cancelled so the worker never picks it up.
    if (row.status === "queued") {
      try {
        const { getBoss } = await import("../../queue/boss.ts");
        const boss = getBoss();
        // We don't track the job id per execution — cancel by data match
        // using findJobs + cancel. If pg-boss isn't started yet (e.g.
        // tests), the dynamic import still returns; getBoss() throws,
        // which we swallow.
        const jobs = await boss.findJobs<{ execution_id: string }>(EXECUTION_RUN_QUEUE, {
          data: { execution_id: id },
        });
        if (jobs.length > 0) {
          const ids = jobs.map((j: { id: string }) => j.id);
          await boss.cancel(EXECUTION_RUN_QUEUE, ids);
        }
      } catch (err) {
        logger.debug({
          module: "queue",
          action: "cancel.skipped",
          msg: "could not cancel queued job (pg-boss not started or no matching job)",
          execution_id: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // (b) Signal the in-process AbortController if the execution is
    // running on this process.
    const signaled = abortCancel(id, "cancelled");

    // (c) Otherwise, write an abort_requested outbox event so another
    // worker process can observe it. In P4 everything runs in one
    // process so this is effectively a future-cluster-mode hint.
    if (!signaled && row.status === "running" && !getAbort(id)) {
      await db.transaction(async (tx) => {
        await writeEvent(tx, {
          tenant_id: principal.tenant_id,
          channel: "execution.status",
          type: "execution.abort_requested",
          payload: { execution_id: id },
        });
      });
    }
    return c.body(null, 202);
  });
}
