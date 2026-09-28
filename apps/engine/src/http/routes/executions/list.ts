// Read-side execution surface — list / get / list-steps.
//
//   GET /v1/executions
//   GET /v1/executions/{id}
//   GET /v1/executions/{id}/steps

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { events, executionSteps, executions, workflows } from "../../../db/schema/index.ts";
import {
  listExecutions,
  loadExecutionOutcome,
  loadFailureSummaries,
} from "../../../execution/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { streamOutboxTail } from "../sse-outbox-tail.ts";
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
        offset: z.coerce.number().int().min(0).optional(),
        workflow_id: z.string().uuid().optional(),
        status: z.string().optional(),
        request_source: z.string().optional(),
        /** Free text, matched against the name or slug of the workflow. */
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
        /** Lineage filter: list the reruns spawned from this execution. */
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

export function registerListRoutes(app: OpenAPIHono<AppEnv>): void {
  // Read-side RBAC: tenant-wide read for the index, resource-scoped
  // grant for /:id and /:id/steps. The stream sub-resource is on the
  // same scope; it's wired here so the gate stays per-file.
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

  app.openapi(listExecutionsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    // Canonical list service: same filter surface as the conversation
    // tool + in-process EngineClient, exact `total` in the same query.
    const { rows, total } = await listExecutions(
      principal.tenant_id,
      {
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
        ...(q.workflow_id !== undefined ? { workflow_id: q.workflow_id } : {}),
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.request_source !== undefined ? { request_source: q.request_source } : {}),
        ...(q.q !== undefined ? { q: q.q } : {}),
        ...(q.started_from !== undefined ? { started_from: new Date(q.started_from) } : {}),
        ...(q.started_to !== undefined ? { started_to: new Date(q.started_to) } : {}),
        ...(q.parent_execution_id !== undefined
          ? { parent_execution_id: q.parent_execution_id }
          : {}),
      },
      db,
    );
    // Name join in one pass, mirroring the schedules route: consumers
    // render WHAT ran, not an opaque workflow_id.
    const ids = [...new Set(rows.map((r) => r.workflow_id).filter((v): v is string => v !== null))];
    const [named, failures] = await Promise.all([
      ids.length
        ? db
            .select({ id: workflows.id, name: workflows.name })
            .from(workflows)
            .where(and(eq(workflows.tenant_id, principal.tenant_id), inArray(workflows.id, ids)))
        : Promise.resolve([]),
      loadFailureSummaries(principal.tenant_id, rows, db),
    ]);
    const nameById = new Map(named.map((w) => [w.id, w.name]));
    return c.json(
      {
        items: rows.map((r) => ({
          ...serializeExec(r, r.workflow_id ? (nameById.get(r.workflow_id) ?? null) : null),
          failure: failures.get(r.id) ?? null,
        })),
        total,
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
    if (!row) throw new NotFoundError("execution");
    const [named, outcome] = await Promise.all([
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
    ]);
    return c.json({ ...serializeExec(row, named[0]?.name ?? null), outcome }, 200);
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

  // -----------------------------------------------------------------
  // GET /v1/executions/{id}/stream — per-execution SSE follow.
  //
  // Gated by the resource-scoped `execution:read` middleware above —
  // following your own run must not require the `audit:read`
  // compliance permission the tenant-wide /v1/events/stream carries.
  // Replays the execution's full event history (queued → step frames
  // → terminal status), then tails live and closes right after the
  // terminal frame so followers of a finished run exit immediately.
  // Hand-rolled outside the openapi() surface like /v1/events/stream
  // (documented in docs/developers/input-surfaces.md).
  // -----------------------------------------------------------------
  app.get("/v1/executions/:id/stream", async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const id = c.req.param("id");
    const found = await db
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.tenant_id, principal.tenant_id), eq(executions.id, id)))
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
  "execution.aborted",
  "execution.timed_out",
]);
