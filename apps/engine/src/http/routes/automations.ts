import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { compare } from "fast-json-patch";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { runExecution } from "../../execution/engine.ts";
import * as workflowSvc from "../../workflows/service.ts";
import { BadRequestError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const RequestSourceSchema = z.enum(["api", "cli", "mcp", "webhook", "tool-chain", "scheduler"]);

const AutomationDefinitionInputSchema = z
  .object({
    name: z.string().min(1),
    slug: z.string().min(1).optional(),
    description: z.string().optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    steps: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
    timeout_ms: z.number().int().positive().optional(),
  })
  .openapi("AutomationDefinitionInput");

const AutomationSchema = z
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
    definition: z.unknown(),
    steps: z.array(z.unknown()),
  })
  .openapi("Automation");

const AutomationListResponse = z
  .object({ items: z.array(AutomationSchema) })
  .openapi("AutomationListResponse");

const AutomationRunBody = z
  .object({
    input: z.unknown().optional(),
    request_source: RequestSourceSchema.optional(),
  })
  .openapi("AutomationRunBody");

const AutomationPreviewBody = z
  .object({
    definition: AutomationDefinitionInputSchema,
    input: z.unknown().optional(),
    request_source: RequestSourceSchema.optional(),
  })
  .openapi("AutomationPreviewBody");

const AutomationApplyBody = z
  .object({
    definition: AutomationDefinitionInputSchema,
  })
  .openapi("AutomationApplyBody");

const AutomationApplyAndRunBody = z
  .object({
    definition: AutomationDefinitionInputSchema,
    input: z.unknown().optional(),
    request_source: RequestSourceSchema.optional(),
  })
  .openapi("AutomationApplyAndRunBody");

const JsonPatchOperationSchema = z
  .object({
    op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
    path: z.string(),
    from: z.string().optional(),
    value: z.unknown().optional(),
  })
  .openapi("AutomationPatchOperation");

const AutomationExecutionSchema = z
  .object({
    execution_id: z.string(),
    status: z.string(),
    output: z.unknown(),
    error: z.unknown().nullable(),
    steps: z.array(z.unknown()),
    warnings: z.array(z.unknown()).optional(),
  })
  .openapi("AutomationExecution");

const AutomationPreviewResponse = z
  .object({
    execution: AutomationExecutionSchema,
  })
  .openapi("AutomationPreviewResponse");

const AutomationChangePreviewResponse = z
  .object({
    automation: AutomationSchema,
    proposed_definition: z.unknown(),
    changed: z.boolean(),
    operations: z.array(JsonPatchOperationSchema),
    execution: AutomationExecutionSchema,
  })
  .openapi("AutomationChangePreviewResponse");

const AutomationApplyResponse = z
  .object({
    automation: AutomationSchema,
    changed: z.boolean(),
    operations: z.array(JsonPatchOperationSchema),
  })
  .openapi("AutomationApplyResponse");

const AutomationApplyAndRunResponse = z
  .object({
    automation: AutomationSchema,
    changed: z.boolean(),
    operations: z.array(JsonPatchOperationSchema),
    execution: AutomationExecutionSchema,
  })
  .openapi("AutomationApplyAndRunResponse");

const listRoute = createRoute({
  method: "get",
  path: "/v1/automations",
  tags: ["automations"],
  summary: "List automations",
  security: [{ bearerAuth: [] }],
  request: {
    query: z
      .object({
        limit: z.coerce.number().int().positive().max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        status: z.enum(["draft", "active", "archived"]).optional(),
        name_contains: z.string().optional(),
      })
      .openapi("ListAutomationsQuery"),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: AutomationListResponse } },
    },
  },
});

const createRouteSpec = createRoute({
  method: "post",
  path: "/v1/automations",
  tags: ["automations"],
  summary: "Create an automation",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: AutomationDefinitionInputSchema } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: AutomationSchema } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/v1/automations/{id}",
  tags: ["automations"],
  summary: "Fetch an automation",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: AutomationSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const updateRoute = createRoute({
  method: "put",
  path: "/v1/automations/{id}",
  tags: ["automations"],
  summary: "Update an automation",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: AutomationDefinitionInputSchema } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: AutomationSchema } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/automations/{id}",
  tags: ["automations"],
  summary: "Delete an automation",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    204: { description: "Deleted" },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const previewRoute = createRoute({
  method: "post",
  path: "/v1/automations/preview",
  tags: ["automations"],
  summary: "Preview an inline automation definition",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: AutomationPreviewBody } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: AutomationPreviewResponse } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const runRoute = createRoute({
  method: "post",
  path: "/v1/automations/{id}/run",
  tags: ["automations"],
  summary: "Run a saved automation inline",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: AutomationRunBody } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: AutomationExecutionSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const changePreviewRoute = createRoute({
  method: "post",
  path: "/v1/automations/{id}/changes/preview",
  tags: ["automations"],
  summary: "Preview changes against a saved automation",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: AutomationPreviewBody } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: AutomationChangePreviewResponse } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const applyRoute = createRoute({
  method: "post",
  path: "/v1/automations/{id}/changes/apply",
  tags: ["automations"],
  summary: "Apply proposed changes to a saved automation",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: AutomationApplyBody } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: AutomationApplyResponse } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const applyAndRunRoute = createRoute({
  method: "post",
  path: "/v1/automations/{id}/changes/apply-and-run",
  tags: ["automations"],
  summary: "Apply changes, save them, and run the saved automation inline",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: AutomationApplyAndRunBody } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: AutomationApplyAndRunResponse } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

function serializeAutomation(workflow: workflowSvc.WorkflowView) {
  return {
    id: workflow.id,
    tenant_id: workflow.tenant_id,
    slug: workflow.slug,
    name: workflow.name,
    lifecycle: workflow.lifecycle,
    current_version_id: workflow.current_version_id,
    current_version: workflow.current_version,
    created_at: workflow.created_at.toISOString(),
    updated_at: workflow.updated_at.toISOString(),
    definition: workflow.definition,
    steps: workflow.steps as unknown[],
  };
}

function serializeExecution(result: Awaited<ReturnType<typeof runExecution>>) {
  return {
    execution_id: result.execution_id,
    status: result.status,
    output: result.output,
    error: result.error,
    steps: result.steps,
    ...(result.warnings ? { warnings: result.warnings } : {}),
  };
}

function resolveExecutionModeHeader(request: Request): "dev" | "prod" {
  const value = request.headers.get("x-subkit-environment");
  if (!value) return "dev";
  const normalized = value.toLowerCase();
  if (normalized === "dev" || normalized === "prod") return normalized;
  throw new BadRequestError("invalid x-subkit-environment header", {
    expected: ["dev", "prod"],
  });
}

function toPatchOperations(current: unknown, proposed: unknown) {
  return compare(current as Record<string, unknown>, proposed as Record<string, unknown>) as Array<{
    op: "add" | "remove" | "replace" | "move" | "copy" | "test";
    path: string;
    from?: string;
    value?: unknown;
  }>;
}

async function runDraftPreview(params: {
  db: AppEnv["Variables"]["db"];
  tenant_id: string;
  principal: ReturnType<typeof requireAuth>;
  trace_id: string | null;
  definition: unknown;
  input: unknown;
  request_source?: z.infer<typeof RequestSourceSchema> | undefined;
  execution_mode: "dev" | "prod";
}) {
  try {
    return await runExecution({
      db: params.db,
      tenant_id: params.tenant_id,
      source: { kind: "draft", definition: params.definition },
      input: params.input,
      options: {
        request_source: params.request_source ?? "api",
        trace_id: params.trace_id,
        principal: params.principal,
        execution_mode: params.execution_mode,
      },
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    const details = (err as { details?: unknown }).details;
    if (code === "draft_invalid" || code === "input_schema_violation") {
      throw new BadRequestError((err as Error).message, {
        code,
        ...(details ? { details } : {}),
      });
    }
    throw err;
  }
}

export function registerAutomationRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/automations", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("workflow:read")(c, next);
    if (c.req.method === "POST") return requirePermission("workflow:write")(c, next);
    return next();
  });
  app.use("/v1/automations/:id", async (c, next) => {
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
  app.use("/v1/automations/:id/run", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("workflow:run", () => ({ type: "workflow", id }))(c, next);
  });
  app.use("/v1/automations/:id/changes/preview", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("workflow:write", () => ({ type: "workflow", id }))(c, next);
  });
  app.use("/v1/automations/:id/changes/apply", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("workflow:write", () => ({ type: "workflow", id }))(c, next);
  });
  app.use("/v1/automations/:id/changes/apply-and-run", async (c, next) => {
    const id = c.req.param("id");
    await requirePermission("workflow:write", () => ({ type: "workflow", id }))(c, async () => {
      await requirePermission("workflow:run", () => ({ type: "workflow", id }))(c, next);
    });
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const query = c.req.valid("query");
    const items = await workflowSvc.listWorkflows(
      principal.tenant_id,
      {
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.offset !== undefined ? { offset: query.offset } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.name_contains !== undefined ? { name_contains: query.name_contains } : {}),
      },
      db,
    );
    return c.json({ items: items.map(serializeAutomation) }, 200);
  });

  app.openapi(createRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const result = await workflowSvc.createWorkflow(
      { tenant_id: principal.tenant_id, def: body, actor_id: principal.id },
      db,
    );
    if ("errors" in result) {
      throw new BadRequestError("invalid automation", { errors: result.errors });
    }
    return c.json(serializeAutomation(result.workflow), 201);
  });

  app.openapi(getRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const workflow = await workflowSvc.getWorkflow(principal.tenant_id, id, db);
    if (!workflow) throw new NotFoundError("automation");
    return c.json(serializeAutomation(workflow), 200);
  });

  app.openapi(updateRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await workflowSvc.updateWorkflow(
      { tenant_id: principal.tenant_id, id, def: body, actor_id: principal.id },
      db,
    );
    if ("errors" in result) {
      if (result.errors[0] === "workflow not found") throw new NotFoundError("automation");
      throw new BadRequestError("invalid automation", { errors: result.errors });
    }
    return c.json(serializeAutomation(result.workflow), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const ok = await workflowSvc.deleteWorkflow(principal.tenant_id, id, principal.id, db);
    if (!ok) throw new NotFoundError("automation");
    return c.body(null, 204);
  });

  app.openapi(previewRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const execution_mode = resolveExecutionModeHeader(c.req.raw);
    const execution = await runDraftPreview({
      db,
      tenant_id: principal.tenant_id,
      principal,
      trace_id: c.get("trace_id") ?? null,
      definition: body.definition,
      input: body.input ?? null,
      request_source: body.request_source,
      execution_mode,
    });
    return c.json({ execution: serializeExecution(execution) }, 200);
  });

  app.openapi(runRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const workflow = await workflowSvc.getWorkflow(principal.tenant_id, id, db);
    if (!workflow) throw new NotFoundError("automation");
    const execution = await runExecution({
      db,
      tenant_id: principal.tenant_id,
      source: { kind: "saved", workflow_id: workflow.id },
      input: body.input ?? null,
      options: {
        request_source: body.request_source ?? "api",
        trace_id: c.get("trace_id") ?? null,
        principal,
        execution_mode: resolveExecutionModeHeader(c.req.raw),
      },
    });
    return c.json(serializeExecution(execution), 200);
  });

  app.openapi(changePreviewRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const workflow = await workflowSvc.getWorkflow(principal.tenant_id, id, db);
    if (!workflow) throw new NotFoundError("automation");
    const operations = toPatchOperations(workflow.definition, body.definition);
    const execution = await runDraftPreview({
      db,
      tenant_id: principal.tenant_id,
      principal,
      trace_id: c.get("trace_id") ?? null,
      definition: body.definition,
      input: body.input ?? null,
      request_source: body.request_source,
      execution_mode: resolveExecutionModeHeader(c.req.raw),
    });
    return c.json(
      {
        automation: serializeAutomation(workflow),
        proposed_definition: body.definition,
        changed: operations.length > 0,
        operations,
        execution: serializeExecution(execution),
      },
      200,
    );
  });

  app.openapi(applyRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const workflow = await workflowSvc.getWorkflow(principal.tenant_id, id, db);
    if (!workflow) throw new NotFoundError("automation");
    const operations = toPatchOperations(workflow.definition, body.definition);
    const result = await workflowSvc.updateWorkflow(
      { tenant_id: principal.tenant_id, id, def: body.definition, actor_id: principal.id },
      db,
    );
    if ("errors" in result) {
      if (result.errors[0] === "workflow not found") throw new NotFoundError("automation");
      throw new BadRequestError("invalid automation", { errors: result.errors });
    }
    return c.json(
      {
        automation: serializeAutomation(result.workflow),
        changed: operations.length > 0,
        operations,
      },
      200,
    );
  });

  app.openapi(applyAndRunRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const workflow = await workflowSvc.getWorkflow(principal.tenant_id, id, db);
    if (!workflow) throw new NotFoundError("automation");
    const operations = toPatchOperations(workflow.definition, body.definition);
    const result = await workflowSvc.updateWorkflow(
      { tenant_id: principal.tenant_id, id, def: body.definition, actor_id: principal.id },
      db,
    );
    if ("errors" in result) {
      if (result.errors[0] === "workflow not found") throw new NotFoundError("automation");
      throw new BadRequestError("invalid automation", { errors: result.errors });
    }
    const execution = await runExecution({
      db,
      tenant_id: principal.tenant_id,
      source: { kind: "saved", workflow_id: id },
      input: body.input ?? null,
      options: {
        request_source: body.request_source ?? "api",
        trace_id: c.get("trace_id") ?? null,
        principal,
        execution_mode: resolveExecutionModeHeader(c.req.raw),
      },
    });
    return c.json(
      {
        automation: serializeAutomation(result.workflow),
        changed: operations.length > 0,
        operations,
        execution: serializeExecution(execution),
      },
      200,
    );
  });
}
