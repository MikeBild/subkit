// Read-side execution surface — list / get / list-steps.
//
//   GET /v1/executions
//   GET /v1/executions/{id}
//   GET /v1/executions/{id}/steps
//
// Phase 4 of the 2026-05 architecture audit (issue #92).

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, desc, eq } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { executionSteps, executions } from "../../../db/schema/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import {
  ExecListResponse,
  ExecSchema,
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
}
