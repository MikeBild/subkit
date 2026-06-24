// Workflow CRUD + history routes.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { listSchedules } from "../../scheduler/index.ts";
import * as svc from "../../workflows/index.ts";
import {
  synthesizeInputSchema,
  TriggerSchema,
  validateWorkflowDef,
} from "../../workflows/index.ts";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const WorkflowSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    slug: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    lifecycle: z.string(),
    current_version_id: z.string().nullable(),
    current_version: z.number().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    steps: z.array(z.unknown()),
    input_schema: z.record(z.string(), z.unknown()).nullable(),
    output_schema: z.record(z.string(), z.unknown()).nullable(),
    output_transform: z.string().nullable(),
    output_transform_function: z.string().nullable(),
    response_filters: z.array(z.unknown()).nullable(),
    validation_expression: z.string().nullable(),
    validation_function: z.string().nullable(),
    timeout_ms: z.number().nullable(),
    max_llm_tokens_per_run: z.number().nullable(),
    // The workflow's trigger (schedule / webhook / request). Surfaced so
    // GET is symmetric with the create/update request body and the MCP
    // get_workflow definition — non-MCP callers (and the `sk` CLI banner)
    // previously couldn't read the trigger from the bare HTTP response.
    trigger: TriggerSchema.nullable(),
  })
  .openapi("Workflow");

const WorkflowListResponse = z
  .object({
    items: z.array(WorkflowSchema),
    /** Exact tenant-scoped count under the same filters (ignores limit/offset). */
    total: z.number().int().nonnegative(),
  })
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

// Create/update request body. This is the full workflow definition the
// caller submits — `createWorkflow`/`updateWorkflow` pass it straight to
// `validateWorkflowDef` (the canonical `WorkflowDefSchema` gate) and to
// `applyTriggerBindings`. Historically this schema was a hand-maintained
// PARTIAL copy of the def that omitted `trigger`, `output_transform`,
// `response_filters`, and the validation_* fields — so a `schedule`
// trigger submitted via the HTTP API (and the `sk` CLI on top of it) was
// SILENTLY STRIPPED here before the save, and no schedule ever bound
// (the trigger-on-save path is the only binding path — there is no
// separate schedule endpoint). The GET serializer already round-trips
// all of these fields, so the request shape was also asymmetric with the
// response. Fix: declare the headline authoring fields explicitly (for an
// accurate OpenAPI contract, symmetric with `serializeWorkflow`) AND
// `.passthrough()` so EVERY other `WorkflowDef` field survives to
// `validateWorkflowDef` — the single source of truth — instead of the
// HTTP layer drifting out of sync with the def and dropping fields.
const CreateBody = z
  .object({
    name: z.string(),
    slug: z.string().optional(),
    description: z.string().optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    steps: z.array(z.record(z.string(), z.unknown())),
    timeout_ms: z.number().int().positive().optional(),
    max_llm_tokens_per_run: z.number().int().positive().optional(),
    // Previously-dropped definition fields — now preserved end to end.
    trigger: TriggerSchema.optional(),
    output_transform: z.string().optional(),
    output_transform_function: z.string().optional(),
    validation_expression: z.string().optional(),
    validation_function: z.string().optional(),
    response_filters: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  // Any other WorkflowDef field (e.g. payload) passes through to
  // validateWorkflowDef rather than being silently stripped here.
  .passthrough()
  .openapi("CreateWorkflowBody");

const IdVersionParam = z.object({ id: z.string().uuid(), version: z.string() });

function serializeWorkflow(w: svc.WorkflowView) {
  return {
    id: w.id,
    tenant_id: w.tenant_id,
    slug: w.slug,
    name: w.name,
    // Same precedence as the `wf_<slug>` catalog: the editable
    // workflows.description column wins, then the DAG's authoring-time
    // description, then null. Keeps the HTTP/dashboard surface in lock-step
    // with what the MCP tool palette shows.
    description: w.description ?? w.definition.description ?? null,
    lifecycle: w.lifecycle,
    current_version_id: w.current_version_id,
    current_version: w.current_version,
    created_at: w.created_at.toISOString(),
    updated_at: w.updated_at.toISOString(),
    steps: w.steps as unknown[],
    // Schema fields surfaced for non-MCP HTTP callers (CI smoke tests,
    // SDK clients, external orchestrators). MCP exposes them via the
    // tool-definition surface; the bare HTTP GET previously omitted
    // them, forcing callers to round-trip through MCP just to learn
    // a workflow's input shape. The HTTP GET exposes
    // `input_schema` / `output_schema` directly.
    input_schema: w.definition.input_schema ?? null,
    output_schema: w.definition.output_schema ?? null,
    output_transform: w.definition.output_transform ?? null,
    output_transform_function: w.definition.output_transform_function ?? null,
    response_filters: w.definition.response_filters ?? null,
    validation_expression: w.definition.validation_expression ?? null,
    validation_function: w.definition.validation_function ?? null,
    timeout_ms: w.definition.timeout_ms ?? null,
    max_llm_tokens_per_run: w.definition.max_llm_tokens_per_run ?? null,
    trigger: w.definition.trigger ?? null,
  };
}

type WorkflowBody = z.infer<typeof CreateBody>;

function preserveOmittedTrigger(body: WorkflowBody, existing: svc.WorkflowView): WorkflowBody {
  if (Object.hasOwn(body, "trigger") || !existing.definition.trigger) return body;
  return { ...body, trigger: existing.definition.trigger };
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

// Metadata-only patch (slug / name / description / lifecycle). Unlike PUT
// (which rewrites the DAG and rolls a new version), this never rotates a
// version — it is the governed rename surface. A slug rename done by raw SQL
// skips the audit log; this route routes through `updateWorkflowMetadata`
// which writes a `WORKFLOW_UPDATED { kind: "metadata" }` audit row.
const WorkflowMetadataPatchBody = z
  .object({
    slug: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    lifecycle: z.enum(["active", "archived"]).optional(),
  })
  .openapi("WorkflowMetadataPatchBody");

const metadataRoute = createRoute({
  method: "patch",
  path: "/v1/workflows/{id}/metadata",
  tags: ["workflows"],
  summary: "Patch workflow metadata (slug/name/description/lifecycle) without rotating a version",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: WorkflowMetadataPatchBody } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: WorkflowSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Slug conflict", content: { "application/json": { schema: ErrorSchema } } },
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

const ScheduleEntry = z
  .object({
    id: z.string(),
    workflow_id: z.string(),
    workflow_slug: z.string().nullable(),
    workflow_name: z.string().nullable(),
    cron: z.string(),
    timezone: z.string(),
    paused: z.boolean(),
    created_at: z.string(),
  })
  .openapi("ScheduleEntry");
const ScheduleListResponse = z
  .object({
    schedules: z.array(ScheduleEntry),
    /** Exact tenant-scoped count under the same filters. */
    total: z.number().int().nonnegative(),
  })
  .openapi("ScheduleListResponse");

const listSchedulesRoute = createRoute({
  method: "get",
  path: "/v1/schedules",
  tags: ["workflows"],
  summary: "List scheduled workflow runs (cron, timezone, paused)",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({ workflow_id: z.string().uuid().optional() }).openapi("ListSchedulesQuery"),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ScheduleListResponse } },
    },
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

const ValidateBody = z
  .object({
    name: z.string().optional(),
    slug: z.string().optional(),
    description: z.string().optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    steps: z.array(z.record(z.string(), z.unknown())),
    timeout_ms: z.number().int().positive().optional(),
  })
  .openapi("ValidateWorkflowBody");

const ValidateResponse = z
  .object({
    ok: z.boolean(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .openapi("ValidateWorkflowResponse");

const validateRoute = createRoute({
  method: "post",
  path: "/v1/workflows/validate",
  tags: ["workflows"],
  summary:
    "Validate a workflow definition (structural + step schema). Does not persist; returns errors inline.",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: ValidateBody } } } },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ValidateResponse } } },
  },
});

const InputSchemaResponse = z
  .object({
    /** "declared" when the workflow has an explicit `input_schema`,
     *  "synthesized" when the schema was inferred from `${input.X}`
     *  placeholders + JSONata `$input.X` references in the steps,
     *  "none" when no inputs are referenced anywhere. */
    source: z.enum(["declared", "synthesized", "none"]),
    schema: z.record(z.string(), z.unknown()).nullable(),
  })
  .openapi("WorkflowInputSchemaResponse");

const inputSchemaRoute = createRoute({
  method: "get",
  path: "/v1/workflows/{id}/input-schema",
  tags: ["workflows"],
  summary: "Get a workflow's input schema (declared or synthesized)",
  description:
    "Returns the workflow's declared `input_schema` when present, otherwise synthesizes one from `$input.X` placeholder and JSONata references discovered in the steps. Mirrors the convention used by the MCP tool surface so non-MCP HTTP callers can discover the input shape without round-tripping through MCP.",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: InputSchemaResponse } } },
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
  // /v1/workflows/validate is a read-only utility; operators that can read
  // workflows can validate a draft without write perms.
  app.use("/v1/schedules", requirePermission("workflow:read"));
  app.use("/v1/workflows/validate", async (c, next) => {
    if (c.req.method === "POST") return requirePermission("workflow:read")(c, next);
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
  app.use("/v1/workflows/:id/history", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("workflow:read", () => ({ type: "workflow", id }))(c, next);
  });
  app.use("/v1/workflows/:id/restore/:version", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("workflow:restore", () => ({ type: "workflow", id }))(c, next);
  });
  app.use("/v1/workflows/:id/metadata", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "PATCH") {
      return requirePermission("workflow:write", () => ({ type: "workflow", id }))(c, next);
    }
    return next();
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
    const { rows, total } = await svc.listWorkflows(principal.tenant_id, opts, db);
    return c.json({ items: rows.map(serializeWorkflow), total }, 200);
  });

  app.openapi(listSchedulesRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const { rows, total } = await listSchedules(db, principal.tenant_id, q.workflow_id);
    // Resolve workflow slugs/names in one pass so `sk schedules` can show
    // WHAT fires, not just an opaque workflow_id.
    const ids = [...new Set(rows.map((r) => r.workflow_id))];
    const named = ids.length
      ? await Promise.all(ids.map((id) => svc.getWorkflow(principal.tenant_id, id, db)))
      : [];
    const nameById = new Map(
      named.filter((w) => w !== null).map((w) => [w.id, { slug: w.slug, name: w.name }]),
    );
    return c.json(
      {
        schedules: rows.map((r) => ({
          id: r.id,
          workflow_id: r.workflow_id,
          workflow_slug: nameById.get(r.workflow_id)?.slug ?? null,
          workflow_name: nameById.get(r.workflow_id)?.name ?? null,
          cron: r.cron,
          timezone: r.timezone,
          paused: r.paused,
          created_at: r.created_at.toISOString(),
        })),
        total,
      },
      200,
    );
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

  app.openapi(validateRoute, async (c) => {
    requireAuth(c);
    const body = c.req.valid("json");
    const res = validateWorkflowDef(body);
    if (res.ok) return c.json({ ok: true }, 200);
    return c.json({ ok: false, errors: res.errors }, 200);
  });

  app.openapi(getRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const wf = await svc.getWorkflow(principal.tenant_id, id, db);
    if (!wf) throw new NotFoundError("workflow");
    return c.json(serializeWorkflow(wf), 200);
  });

  app.openapi(inputSchemaRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const wf = await svc.getWorkflow(principal.tenant_id, id, db);
    if (!wf) throw new NotFoundError("workflow");

    // Declared schema wins. When absent, synthesize from the steps —
    // same code path the MCP tool listing uses, so the two surfaces
    // stay in lockstep.
    if (wf.definition.input_schema) {
      return c.json({ source: "declared" as const, schema: wf.definition.input_schema }, 200);
    }
    const synthesized = synthesizeInputSchema(wf.definition);
    if (synthesized) {
      return c.json({ source: "synthesized" as const, schema: synthesized }, 200);
    }
    return c.json({ source: "none" as const, schema: null }, 200);
  });

  app.openapi(updateRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const existing = await svc.getWorkflow(principal.tenant_id, id, db);
    if (!existing) throw new NotFoundError("workflow");
    const result = await svc.updateWorkflow(
      {
        tenant_id: principal.tenant_id,
        id,
        def: preserveOmittedTrigger(body, existing),
        actor_id: principal.id,
      },
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

  app.openapi(metadataRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await svc.updateWorkflowMetadata(
      {
        tenant_id: principal.tenant_id,
        id,
        actor_id: principal.id,
        ...(body.slug !== undefined ? { slug: body.slug } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.lifecycle !== undefined ? { lifecycle: body.lifecycle } : {}),
      },
      db,
    );
    if ("workflow" in result && result.workflow) {
      return c.json(serializeWorkflow(result.workflow), 200);
    }
    // Error variant. Map a slug collision to 409, missing workflow to 404,
    // everything else (bad slug shape, no-op) to 400.
    if (result.conflict) {
      throw new ConflictError("slug already in use by a live workflow", {
        errors: result.errors,
        conflict: result.conflict,
      });
    }
    if (result.errors[0] === "workflow not found") {
      throw new NotFoundError("workflow");
    }
    throw new BadRequestError("invalid workflow metadata", { errors: result.errors });
  });

  app.openapi(deleteRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const ok = await svc.deleteWorkflow(principal.tenant_id, id, principal.id, db);
    if (!ok) throw new NotFoundError("workflow");
    return c.body(null, 204);
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
