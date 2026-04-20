// Workflow CRUD + run + history routes.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { workflows, workflowVersions } from "../../db/schema/index.ts";
import { runExecution } from "../../execution/engine.ts";
import { createExecution } from "../../execution/state.ts";
import { getBoss } from "../../queue/boss.ts";
import { EXECUTION_RUN_QUEUE, type ExecutionRunJob } from "../../queue/queues.ts";
import * as svc from "../../workflows/service.ts";
import { BadRequestError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const WorkflowSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    slug: z.string(),
    name: z.string(),
    lifecycle: z.string(),
    current_version_id: z.string().nullable(),
    current_version: z.number().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    steps: z.array(z.unknown()),
  })
  .openapi("Workflow");

const WorkflowListResponse = z
  .object({ items: z.array(WorkflowSchema) })
  .openapi("WorkflowListResponse");

const VersionSchema = z
  .object({
    id: z.string(),
    workflow_id: z.string(),
    version: z.number(),
    note: z.string().nullable(),
    created_at: z.string(),
    dag: z.unknown(),
  })
  .openapi("WorkflowVersion");

const VersionListResponse = z
  .object({ items: z.array(VersionSchema) })
  .openapi("WorkflowVersionListResponse");

const CreateBody = z
  .object({
    name: z.string(),
    slug: z.string().optional(),
    description: z.string().optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    steps: z.array(z.record(z.string(), z.unknown())),
    timeout_ms: z.number().int().positive().optional(),
  })
  .openapi("CreateWorkflowBody");

const RunBody = z
  .object({
    input: z.unknown().optional(),
    request_source: z.enum(["api", "cli", "mcp", "webhook", "tool-chain", "scheduler"]).optional(),
  })
  .openapi("RunWorkflowBody");

const ExecutionResponseSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    output: z.unknown().optional(),
    error: z.unknown().nullable().optional(),
    steps: z.array(z.unknown()).optional(),
  })
  .openapi("WorkflowRunResponse");

const IdVersionParam = z.object({ id: z.string().uuid(), version: z.string() });

function serializeWorkflow(w: svc.WorkflowView) {
  return {
    id: w.id,
    tenant_id: w.tenant_id,
    slug: w.slug,
    name: w.name,
    lifecycle: w.lifecycle,
    current_version_id: w.current_version_id,
    current_version: w.current_version,
    created_at: w.created_at.toISOString(),
    updated_at: w.updated_at.toISOString(),
    steps: w.steps as unknown[],
  };
}

const listRoute = createRoute({
  method: "get",
  path: "/v1/workflows",
  tags: ["workflows"],
  summary: "List workflows",
  security: [{ bearerAuth: [] }],
  request: {
    query: z
      .object({
        limit: z.coerce.number().int().positive().max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        status: z.enum(["draft", "active", "archived"]).optional(),
        name_contains: z.string().optional(),
      })
      .openapi("ListWorkflowsQuery"),
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: WorkflowListResponse } } },
  },
});

const createRouteSpec = createRoute({
  method: "post",
  path: "/v1/workflows",
  tags: ["workflows"],
  summary: "Create a workflow",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: CreateBody } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: WorkflowSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/v1/workflows/{id}",
  tags: ["workflows"],
  summary: "Fetch a workflow",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: WorkflowSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateRoute = createRoute({
  method: "put",
  path: "/v1/workflows/{id}",
  tags: ["workflows"],
  summary: "Update a workflow",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: CreateBody } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: WorkflowSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/workflows/{id}",
  tags: ["workflows"],
  summary: "Delete a workflow",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    204: { description: "Deleted" },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const runRoute = createRoute({
  method: "post",
  path: "/v1/workflows/{id}/run",
  tags: ["workflows"],
  summary: "Run a workflow (async by default, ?sync=1 for inline)",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    query: z.object({ sync: z.coerce.boolean().optional() }).openapi("RunWorkflowQuery"),
    body: { content: { "application/json": { schema: RunBody } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ExecutionResponseSchema } },
    },
    202: {
      description: "Queued",
      content: { "application/json": { schema: ExecutionResponseSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const historyRoute = createRoute({
  method: "get",
  path: "/v1/workflows/{id}/history",
  tags: ["workflows"],
  summary: "List workflow versions",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: VersionListResponse } } },
  },
});

const restoreRoute = createRoute({
  method: "post",
  path: "/v1/workflows/{id}/restore/{version}",
  tags: ["workflows"],
  summary: "Restore a previous workflow version",
  security: [{ bearerAuth: [] }],
  request: { params: IdVersionParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: WorkflowSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerWorkflowRoutes(app: OpenAPIHono<AppEnv>): void {
  // Pass-2 C5: RBAC gating. Every mutation + run goes through
  // `requirePermission` which calls the `can()` evaluator. Admin
  // principals short-circuit, so existing tests keep passing.
  app.use("/v1/workflows", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("workflow:read")(c, next);
    if (c.req.method === "POST") return requirePermission("workflow:write")(c, next);
    return next();
  });
  app.use("/v1/workflows/:id", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "GET") {
      return requirePermission("workflow:read", () => ({ type: "workflow", id }))(c, next);
    }
    if (c.req.method === "PUT") {
      return requirePermission("workflow:write", () => ({ type: "workflow", id }))(c, next);
    }
    if (c.req.method === "DELETE") {
      return requirePermission("workflow:delete", () => ({ type: "workflow", id }))(c, next);
    }
    return next();
  });
  app.use("/v1/workflows/:id/run", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("workflow:run", () => ({ type: "workflow", id }))(c, next);
  });
  app.use("/v1/workflows/:id/history", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("workflow:read", () => ({ type: "workflow", id }))(c, next);
  });
  app.use("/v1/workflows/:id/restore/:version", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("workflow:restore", () => ({ type: "workflow", id }))(c, next);
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const opts: svc.ListWorkflowsOptions = {};
    if (q.limit !== undefined) opts.limit = q.limit;
    if (q.offset !== undefined) opts.offset = q.offset;
    if (q.status !== undefined) opts.status = q.status;
    if (q.name_contains !== undefined) opts.name_contains = q.name_contains;
    const items = await svc.listWorkflows(principal.tenant_id, opts, db);
    return c.json({ items: items.map(serializeWorkflow) }, 200);
  });

  app.openapi(createRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const result = await svc.createWorkflow(
      { tenant_id: principal.tenant_id, def: body, actor_id: principal.id },
      db,
    );
    if ("errors" in result) {
      throw new BadRequestError("invalid workflow", { errors: result.errors });
    }
    return c.json(serializeWorkflow(result.workflow), 201);
  });

  app.openapi(getRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const wf = await svc.getWorkflow(principal.tenant_id, id, db);
    if (!wf) throw new NotFoundError("workflow");
    return c.json(serializeWorkflow(wf), 200);
  });

  app.openapi(updateRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await svc.updateWorkflow(
      { tenant_id: principal.tenant_id, id, def: body, actor_id: principal.id },
      db,
    );
    if ("errors" in result) {
      if (result.errors[0] === "workflow not found") {
        throw new NotFoundError("workflow");
      }
      throw new BadRequestError("invalid workflow", { errors: result.errors });
    }
    return c.json(serializeWorkflow(result.workflow), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const ok = await svc.deleteWorkflow(principal.tenant_id, id, principal.id, db);
    if (!ok) throw new NotFoundError("workflow");
    return c.body(null, 204);
  });

  app.openapi(runRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const query = c.req.valid("query");
    const wf = await svc.getWorkflow(principal.tenant_id, id, db);
    if (!wf) throw new NotFoundError("workflow");
    const trace_id = c.get("trace_id") ?? null;

    // Environment header: `x-subkit-environment: dev|prod`. Default dev
    // so legacy callers are unchanged. Anything else is a client error.
    const envHeader = c.req.header("x-subkit-environment")?.toLowerCase();
    let execution_mode: "dev" | "prod" = "dev";
    if (envHeader !== undefined) {
      if (envHeader !== "dev" && envHeader !== "prod") {
        throw new BadRequestError("invalid x-subkit-environment header", {
          expected: ["dev", "prod"],
        });
      }
      execution_mode = envHeader;
    }

    // Sync path: run inline, return full result. Kept so tests and tight
    // loops don't need a live pg-boss.
    if (query.sync) {
      let result: Awaited<ReturnType<typeof runExecution>>;
      try {
        result = await runExecution({
          db,
          tenant_id: principal.tenant_id,
          workflow_id: id,
          input: body.input ?? null,
          options: {
            request_source: body.request_source ?? "api",
            trace_id,
            principal,
            execution_mode,
          },
        });
      } catch (err) {
        // Pre-execution validation errors throw before an execution row
        // exists. Surface them as 400 with the full message so callers
        // see the offending field name(s).
        const code = (err as { code?: string }).code;
        const details = (err as { details?: unknown }).details;
        if (code === "input_schema_violation") {
          throw new BadRequestError((err as Error).message, {
            code,
            ...(details ? { details } : {}),
          });
        }
        throw err;
      }
      return c.json(
        {
          id: result.execution_id,
          status: result.status,
          output: result.output,
          error: result.error,
          steps: result.steps,
        },
        200,
      );
    }

    // Async path: materialize the executions row here so the API can
    // respond with an id + `queued` status immediately. Then enqueue a
    // pg-boss job; the worker picks it up and calls the engine with
    // `existing_execution_id` so no extra row is created.
    if (!wf.current_version_id) {
      throw new BadRequestError("workflow has no active version");
    }
    // Resolve current version id via table (svc returns the version number only).
    const versionRows = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
    const versionId = versionRows[0]?.current_version_id;
    if (!versionId) throw new BadRequestError("workflow has no active version");
    // Touch workflowVersions import so the barrel isn't flagged as unused.
    void workflowVersions;
    const execution_id = await createExecution(db, {
      tenant_id: principal.tenant_id,
      workflow_id: id,
      workflow_version_id: versionId,
      request_source: body.request_source ?? "api",
      parent_execution_id: null,
      execution_mode,
    });
    const job: ExecutionRunJob = {
      tenant_id: principal.tenant_id,
      workflow_id: id,
      execution_id,
      input: body.input ?? null,
      request_source: body.request_source ?? "api",
      trace_id,
      execution_mode,
    };
    const boss = getBoss();
    await boss.send(EXECUTION_RUN_QUEUE, job);
    return c.json({ id: execution_id, status: "queued" }, 202);
  });

  app.openapi(historyRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const items = await svc.listWorkflowVersions(principal.tenant_id, id, db);
    return c.json(
      {
        items: items.map((v) => ({
          id: v.id,
          workflow_id: v.workflow_id,
          version: v.version,
          note: v.note,
          created_at: v.created_at.toISOString(),
          dag: v.dag,
        })),
      },
      200,
    );
  });

  app.openapi(restoreRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id, version } = c.req.valid("param");
    const v = Number.parseInt(version, 10);
    if (!Number.isFinite(v) || v <= 0) {
      throw new BadRequestError("version must be a positive integer");
    }
    const wf = await svc.restoreWorkflowVersion(principal.tenant_id, id, v, principal.id, db);
    if (!wf) throw new NotFoundError("workflow_version");
    return c.json(serializeWorkflow(wf), 200);
  });
}
