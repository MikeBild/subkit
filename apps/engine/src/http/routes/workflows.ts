import { ScheduleEntry } from "./workflow-schedule-schemas.ts";
// Workflow CRUD + history routes.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { AuditAction, auditAwait } from "../../audit/index.ts";
import {
  bindingFor,
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  loadTriggerBindings,
  type ScheduleRow,
  updateSchedule,
} from "../../scheduler/index.ts";
import * as svc from "../../workflows/index.ts";
import {
  groupByCategory,
  listConnectorRefs,
  loadCategoryIndex,
  synthesizeInputSchema,
  TriggerSchema,
  UNCATEGORIZED,
  validateWorkflowDef,
} from "../../workflows/index.ts";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";
import { registerWorkflowAuthorityRoutes } from "./workflow-authorities.ts";
import { registerWorkflowDraftRoutes } from "./workflow-drafts.ts";
import {
  serializeOne,
  serializeWorkflow,
  WorkflowListResponse,
  WorkflowSchema,
} from "./workflow-representation.ts";

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
        q: z.string().min(1).max(200).optional(),
        sort: z.enum(["name", "lifecycle", "created_at", "updated_at"]).optional(),
        order: z.enum(["asc", "desc"]).optional(),
        category: z
          .string()
          .optional()
          .describe("Only workflows in this catalog block (see the `category` field on each item)"),
        connector: z
          .string()
          .optional()
          .describe("Only workflows whose current version uses this connector (id or slug)"),
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

const ScheduleUpsertResponse = ScheduleEntry.extend({
  upsert_status: z.enum(["created", "updated"]),
}).openapi("ScheduleUpsertResponse");
const ScheduleInputSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);
/**
 * A saved draft that is not the version a schedule runs. The reader of a held
 * schedule needs it: the running version is exactly the one that could not be
 * approved, and without this the repair waiting next to it stays invisible.
 */
const preparedVersionId = (
  wf: { draft_version_id?: string | null; current_version_id: string | null } | null | undefined,
) =>
  wf?.draft_version_id && wf.draft_version_id !== wf.current_version_id
    ? wf.draft_version_id
    : null;

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

// Schedule write surface. The repo layer upserts on (tenant_id,
// workflow_id) — one schedule per workflow, same invariant the inline
// trigger path enforces — so POST on an already-scheduled workflow
// updates the existing row instead of multiplying fire times.
const ScheduleCreateBody = z
  .object({
    workflow_id: z.string().uuid(),
    /** 5-field cron or the `every:<seconds>` dev shorthand. */
    cron: z.string().min(1),
    timezone: z.string().optional(),
    /** Connector environment for unattended runs; production is the safe
     *  operational default for a durable schedule. */
    execution_mode: z.enum(["dev", "prod"]).optional(),
    paused: z.boolean().optional(),
    /** Input payload passed to every scheduled run. */
    input: ScheduleInputSchema.optional(),
  })
  .openapi("ScheduleCreateBody");

const ScheduleUpdateBody = z
  .object({
    cron: z.string().min(1).optional(),
    timezone: z.string().optional(),
    execution_mode: z.enum(["dev", "prod"]).optional(),
    paused: z.boolean().optional(),
    input: ScheduleInputSchema.optional(),
  })
  .openapi("ScheduleUpdateBody");

const ScheduleDeleteResponse = z
  .object({ id: z.string(), deleted: z.boolean() })
  .openapi("ScheduleDeleteResponse");

const createScheduleRoute = createRoute({
  method: "post",
  path: "/v1/schedules",
  tags: ["workflows"],
  summary: "Schedule a workflow (upserts the workflow's single schedule)",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: ScheduleCreateBody } } },
  },
  responses: {
    200: {
      description: "Existing workflow schedule updated",
      content: { "application/json": { schema: ScheduleUpsertResponse } },
    },
    201: {
      description: "Schedule created",
      content: { "application/json": { schema: ScheduleUpsertResponse } },
    },
    400: {
      description: "Invalid cron",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Workflow not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Workflow is archived",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const updateScheduleRoute = createRoute({
  method: "put",
  path: "/v1/schedules/{id}",
  tags: ["workflows"],
  summary: "Update a schedule's cron, timezone, paused flag, or input",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: ScheduleUpdateBody } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ScheduleEntry } } },
    400: {
      description: "Invalid cron",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Schedule not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const deleteScheduleRoute = createRoute({
  method: "delete",
  path: "/v1/schedules/{id}",
  tags: ["workflows"],
  summary: "Delete a schedule",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ScheduleDeleteResponse } },
    },
    404: {
      description: "Schedule not found",
      content: { "application/json": { schema: ErrorSchema } },
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
  registerWorkflowAuthorityRoutes(app);
  registerWorkflowDraftRoutes(app);
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
  app.use("/v1/schedules", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("workflow:read")(c, next);
    if (c.req.method === "POST") return requirePermission("workflow:write")(c, next);
    return next();
  });
  app.use("/v1/schedules/:id", async (c, next) => {
    if (c.req.method === "PUT" || c.req.method === "DELETE") {
      return requirePermission("workflow:write")(c, next);
    }
    return next();
  });
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
    if (q.q !== undefined) opts.q = q.q;
    if (q.sort !== undefined) opts.sort = q.sort;
    if (q.order !== undefined) opts.order = q.order;
    if (q.category !== undefined) opts.category = q.category;
    if (q.connector !== undefined) opts.connector = q.connector;
    const { rows, total } = await svc.listWorkflows(principal.tenant_id, opts, db);
    // Derived over the whole catalog, not the page, so a workflow reports the
    // same block whether or not the caller filtered or paged.
    const [categories, connectorRefs, bindings] = await Promise.all([
      loadCategoryIndex(principal.tenant_id, db),
      listConnectorRefs(principal.tenant_id, db),
      loadTriggerBindings(
        principal.tenant_id,
        rows.map((w) => w.id),
        db,
      ),
    ]);
    const items = rows.map((w) => ({
      ...serializeWorkflow(w, bindingFor(bindings, w.id)),
      category: categories.get(w.slug) ?? UNCATEGORIZED,
      connectors: connectorRefs.get(w.id) ?? [],
    }));
    // Blocks describe the catalog, not the page: a chip row derived from the
    // filtered page would collapse to the chip the caller just picked.
    const blocks = groupByCategory(
      [...categories.values()].map((category) => ({ category })),
      (i) => i.category,
    ).map((b) => ({ category: b.category, count: b.items.length }));
    return c.json({ items, total, categories: blocks }, 200);
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
    const nameById = new Map(named.filter((w) => w !== null).map((w) => [w.id, w]));
    return c.json(
      {
        schedules: rows.map((r) => ({
          id: r.id,
          workflow_id: r.workflow_id,
          workflow_slug: nameById.get(r.workflow_id)?.slug ?? null,
          workflow_name: nameById.get(r.workflow_id)?.name ?? null,
          prepared_version_id: preparedVersionId(nameById.get(r.workflow_id)),
          admission_hold:
            r.paused || !named.find((w) => w?.id === r.workflow_id && w.lifecycle !== "archived")
              ? null
              : r.admission_hold,
          cron: r.cron,
          timezone: r.timezone,
          execution_mode: r.execution_mode,
          paused: r.paused,
          input: r.input ?? null,
          created_at: r.created_at.toISOString(),
        })),
        total,
      },
      200,
    );
  });

  // Shared serializer for the schedule write handlers — same shape the
  // list route emits so `sk schedules` renders all four uniformly.
  const serializeSchedule = async (
    c: { get(key: "db"): unknown },
    tenant_id: string,
    row: ScheduleRow,
  ) => {
    const db = c.get("db") as Parameters<typeof listSchedules>[0];
    const wf = await svc.getWorkflow(tenant_id, row.workflow_id, db);
    return {
      id: row.id,
      workflow_id: row.workflow_id,
      workflow_slug: wf?.slug ?? null,
      workflow_name: wf?.name ?? null,
      prepared_version_id: preparedVersionId(wf),
      admission_hold: row.paused || !wf || wf.lifecycle === "archived" ? null : row.admission_hold,
      cron: row.cron,
      timezone: row.timezone,
      execution_mode: row.execution_mode,
      paused: row.paused,
      input: row.input ?? null,
      created_at: row.created_at.toISOString(),
    };
  };

  const rethrowScheduleError = (err: unknown): never => {
    const code = (err as { code?: string } | null)?.code;
    if (code === "invalid_cron") {
      throw new BadRequestError(err instanceof Error ? err.message : "invalid cron");
    }
    if (code === "workflow_not_found") throw new NotFoundError("workflow");
    if (code === "workflow_archived") {
      throw new ConflictError(err instanceof Error ? err.message : "workflow is archived");
    }
    throw err;
  };

  app.openapi(createScheduleRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    let outcome: Awaited<ReturnType<typeof createSchedule>>;
    try {
      outcome = await createSchedule(db, {
        tenant_id: principal.tenant_id,
        workflow_id: body.workflow_id,
        cron: body.cron,
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
        ...(body.execution_mode !== undefined ? { execution_mode: body.execution_mode } : {}),
        ...(body.paused !== undefined ? { paused: body.paused } : {}),
        ...(body.input !== undefined ? { input: body.input } : {}),
      });
    } catch (err) {
      rethrowScheduleError(err);
      throw err;
    }
    const { row, status } = outcome;
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: "user",
        actor_id: principal.id,
        action: status === "created" ? AuditAction.SCHEDULE_CREATED : AuditAction.SCHEDULE_UPDATED,
        resource_type: "schedule",
        resource_id: row.id,
        result: "success",
        metadata: {
          workflow_id: row.workflow_id,
          cron: row.cron,
          timezone: row.timezone,
          execution_mode: row.execution_mode,
          paused: row.paused,
          kind: status,
          input_changed: body.input !== undefined,
        },
      },
      db,
    );
    const response = {
      ...(await serializeSchedule(c, principal.tenant_id, row)),
      upsert_status: status,
    };
    return status === "created" ? c.json(response, 201) : c.json(response, 200);
  });

  app.openapi(updateScheduleRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    let row: ScheduleRow | null;
    try {
      row = await updateSchedule(db, principal.tenant_id, id, {
        ...(body.cron !== undefined ? { cron: body.cron } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
        ...(body.execution_mode !== undefined ? { execution_mode: body.execution_mode } : {}),
        ...(body.paused !== undefined ? { paused: body.paused } : {}),
        ...(body.input !== undefined ? { input: body.input } : {}),
      });
    } catch (err) {
      rethrowScheduleError(err);
      throw err;
    }
    if (!row) throw new NotFoundError("schedule");
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: "user",
        actor_id: principal.id,
        action: AuditAction.SCHEDULE_UPDATED,
        resource_type: "schedule",
        resource_id: row.id,
        result: "success",
        metadata: {
          workflow_id: row.workflow_id,
          patch: {
            ...(body.cron !== undefined ? { cron: body.cron } : {}),
            ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
            ...(body.execution_mode !== undefined ? { execution_mode: body.execution_mode } : {}),
            ...(body.paused !== undefined ? { paused: body.paused } : {}),
            ...(body.input !== undefined ? { input: true } : {}),
          },
        },
      },
      db,
    );
    return c.json(await serializeSchedule(c, principal.tenant_id, row), 200);
  });

  app.openapi(deleteScheduleRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    // Fetch before delete so the audit entry carries the workflow id.
    const before = await getSchedule(db, principal.tenant_id, id);
    const ok = await deleteSchedule(db, principal.tenant_id, id);
    if (!ok) throw new NotFoundError("schedule");
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: "user",
        actor_id: principal.id,
        action: AuditAction.SCHEDULE_DELETED,
        resource_type: "schedule",
        resource_id: id,
        result: "success",
        metadata: { workflow_id: before?.workflow_id ?? null },
      },
      db,
    );
    return c.json({ id, deleted: true }, 200);
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
    return c.json(await serializeOne(result.workflow, principal.tenant_id, db), 201);
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
    return c.json(await serializeOne(wf, principal.tenant_id, db), 200);
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
    return c.json(await serializeOne(result.workflow, principal.tenant_id, db), 200);
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
      return c.json(await serializeOne(result.workflow, principal.tenant_id, db), 200);
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
    return c.json(await serializeOne(wf, principal.tenant_id, db), 200);
  });
}
