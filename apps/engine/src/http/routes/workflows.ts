import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { WORKFLOW_OPERATING_STATUSES } from "@shared/workflow-operating-status.ts";
import {
  AcceptDescriptionSchema,
  CategorySchema,
  compareCategoryCounts,
  DescriptionSchema,
  descriptionAcceptanceValid,
} from "../../api/catalog-metadata.ts";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { AuditAction, auditAwait } from "../../audit/index.ts";
import { can } from "../../rbac/index.ts";
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
  listConnectorRefs,
  loadCategoryVocabulary,
  resolveWorkflowInputSchema,
  TriggerSchema,
  validateTenantWorkflowDef,
} from "../../workflows/index.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";
import { assertRecipeOrigin } from "./recipe-origin.ts";
import { registerWorkflowAuthorityRoutes } from "./workflow-authorities.ts";
import { registerWorkflowDiagnosisRoutes } from "./workflow-diagnosis.ts";
import { registerWorkflowDraftRoutes } from "./workflow-drafts.ts";
import { registerWorkflowInvocationRoutes } from "./workflow-invocation.ts";
import {
  serializeOne,
  serializeWorkflow,
  WorkflowListResponse,
  WorkflowSchema,
} from "./workflow-representation.ts";
import { ScheduleEntry } from "./workflow-schedule-schemas.ts";
import { registerTransactionalMailRoutes } from "./workflow-transactional-mail.ts";
import { registerWorkflowVersionRoutes } from "./workflow-versions.ts";

const CreateBody = z
  .object({
    name: z.string(),
    slug: z.string().optional(),
    description: DescriptionSchema.optional(),
    category: CategorySchema.optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    steps: z.array(z.record(z.string(), z.unknown())),
    timeout_ms: z.number().int().positive().optional(),
    max_llm_tokens_per_run: z.number().int().positive().optional(),
    trigger: TriggerSchema.optional(),
    output_transform: z.string().optional(),
    output_transform_function: z.string().optional(),
    validation_expression: z.string().optional(),
    validation_function: z.string().optional(),
    response_filters: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough()
  .openapi("CreateWorkflowBody");

const CreateRequestBody = CreateBody.extend({
  recipe: svc.RecipeOriginSchema.optional(),
  id: z.string().uuid().optional().openapi({
    description:
      "Operator-chosen workflow id, for a client that addresses the workflow by a fixed id. Admins only; unique per installation.",
  }),
}).openapi("CreateWorkflowRequest");

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
        operating_status: z.enum(WORKFLOW_OPERATING_STATUSES).optional(),
        name_contains: z.string().optional(),
        q: z.string().min(1).max(200).optional(),
        sort: z.enum(["name", "lifecycle", "created_at", "updated_at"]).optional(),
        order: z.enum(["asc", "desc"]).optional(),
        description_source: z.enum(["llm", "human"]).optional(),
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
  request: { body: { content: { "application/json": { schema: CreateRequestBody } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: WorkflowSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    422: {
      description:
        "The recipe origin names no shipped recipe, or the definition was not built from it",
      content: { "application/json": { schema: ErrorSchema } },
    },
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

const WorkflowMetadataPatchBody = z
  .object({
    slug: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    description: DescriptionSchema.nullable().optional(),
    accept_description: AcceptDescriptionSchema.optional(),
    category: CategorySchema.nullable().optional(),
    lifecycle: z.enum(["active", "archived"]).optional(),
  })
  .refine(descriptionAcceptanceValid, {
    message: "accept_description requires the exact nonempty description",
    path: ["accept_description"],
  })
  .openapi("WorkflowMetadataPatchBody");

const metadataRoute = createRoute({
  method: "patch",
  path: "/v1/workflows/{id}/metadata",
  tags: ["workflows"],
  summary:
    "Patch workflow metadata (slug/name/description/category/lifecycle) without rotating a version",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: WorkflowMetadataPatchBody } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: WorkflowSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description: "Slug or description conflict",
      content: { "application/json": { schema: ErrorSchema } },
    },
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
const preparedVersionId = (
  wf: { draft_version_id?: string | null; current_version_id: string | null } | null | undefined,
) =>
  wf?.draft_version_id && wf.draft_version_id !== wf.current_version_id
    ? wf.draft_version_id
    : null;

const ScheduleListResponse = z
  .object({
    schedules: z.array(ScheduleEntry),
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

const ScheduleCreateBody = z
  .object({
    workflow_id: z.string().uuid(),
    cron: z.string().min(1),
    timezone: z.string().optional(),
    execution_mode: z.enum(["dev", "prod"]).optional(),
    paused: z.boolean().optional(),
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

const ValidateBody = CreateBody.omit({ category: true })
  .extend({ name: z.string().optional() })
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
  registerTransactionalMailRoutes(app);
  registerWorkflowDiagnosisRoutes(app);
  registerWorkflowInvocationRoutes(app);
  registerWorkflowDraftRoutes(app);
  registerWorkflowVersionRoutes(app);
  app.use("/v1/workflows", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("workflow:read")(c, next);
    if (c.req.method === "POST") return requirePermission("workflow:write")(c, next);
    return next();
  });
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
    if (q.operating_status !== undefined) opts.operating_status = q.operating_status;
    const operatingMay = async (
      permission: "schedule:read" | "inbound_hook:read" | "connector:read",
    ) =>
      (await can(db, { tenant_id: principal.tenant_id, principal, permission, quiet: true })).allow;
    const [scheduleAccess, hookAccess, connectorAccess] = await Promise.all([
      operatingMay("schedule:read"),
      operatingMay("inbound_hook:read"),
      operatingMay("connector:read"),
    ]);
    opts.include_operating_status = true;
    opts.operating_access = {
      schedules: scheduleAccess,
      hooks: hookAccess,
      connectors: connectorAccess,
    };
    if (q.name_contains !== undefined) opts.name_contains = q.name_contains;
    if (q.q !== undefined) opts.q = q.q;
    if (q.sort !== undefined) opts.sort = q.sort;
    if (q.order !== undefined) opts.order = q.order;
    if (q.category !== undefined) opts.category = q.category;
    if (q.description_source) opts.description_source = q.description_source;
    if (q.connector !== undefined) opts.connector = q.connector;
    const { rows, total } = await svc.listWorkflows(principal.tenant_id, opts, db);
    const [vocabulary, connectorRefs, bindings] = await Promise.all([
      loadCategoryVocabulary(principal.tenant_id, db),
      listConnectorRefs(principal.tenant_id, db),
      loadTriggerBindings(
        principal.tenant_id,
        rows.map((w) => w.id),
        db,
      ),
    ]);
    const items = rows.map((w) => ({
      ...serializeWorkflow(w, bindingFor(bindings, w.id)),
      connectors: connectorRefs.get(w.id) ?? [],
    }));
    const blocks = vocabulary
      .filter((usage) => usage.counts.workflow > 0)
      .map((usage) => ({ category: usage.category, count: usage.counts.workflow }))
      .sort(compareCategoryCounts);
    return c.json({ items, total, categories: blocks }, 200);
  });

  app.openapi(listSchedulesRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const { rows, total } = await listSchedules(db, principal.tenant_id, q.workflow_id);
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
          input_error: r.paused ? null : r.input_error,
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
      input_error: row.paused ? null : row.input_error,
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
    if (code === "input_schema_violation") {
      const details = (err as { details?: unknown } | null)?.details;
      throw new BadRequestError(
        err instanceof Error ? err.message : "schedule input does not match the active workflow",
        details && typeof details === "object" && !Array.isArray(details)
          ? (details as Record<string, unknown>)
          : undefined,
      );
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
        actor_type: principal.kind,
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
        actor_type: principal.kind,
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
    const before = await getSchedule(db, principal.tenant_id, id);
    const ok = await deleteSchedule(db, principal.tenant_id, id);
    if (!ok) throw new NotFoundError("schedule");
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
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
    const { category, recipe, id: chosenId, ...def } = c.req.valid("json");
    if (recipe) assertRecipeOrigin(recipe, def);
    if (chosenId && !principal.roles.includes("admin"))
      throw new ForbiddenError("only an admin may choose a workflow id");
    const result = await svc.createWorkflow(
      {
        tenant_id: principal.tenant_id,
        def,
        ...(chosenId ? { workflow_id: chosenId } : {}),
        actor_id: principal.id,
        actor_type: principal.kind,
        ...(category !== undefined ? { metadata: { category } } : {}),
        ...(recipe ? { audit_metadata: svc.recipeAuditMetadata(recipe) } : {}),
      },
      db,
    );
    if ("errors" in result) {
      throw new BadRequestError("invalid workflow", { errors: result.errors });
    }
    return c.json(await serializeOne(result.workflow, principal.tenant_id, db), 201);
  });

  app.openapi(validateRoute, async (c) => {
    const principal = requireAuth(c);
    const body = c.req.valid("json");
    const res = await validateTenantWorkflowDef(body, principal.tenant_id, c.get("db"), {
      destinationTier: "tokens",
    });
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

    return c.json(resolveWorkflowInputSchema(wf.definition), 200);
  });

  app.openapi(updateRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { category, ...body } = c.req.valid("json");
    const existing = await svc.getWorkflow(principal.tenant_id, id, db);
    if (!existing) throw new NotFoundError("workflow");
    const result = await svc.updateWorkflow(
      {
        tenant_id: principal.tenant_id,
        id,
        def: preserveOmittedTrigger(body, existing),
        actor_id: principal.id,
        actor_type: principal.kind,
        ...(category !== undefined ? { metadata: { category } } : {}),
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
        actor_type: principal.kind,
        ...(body.slug !== undefined ? { slug: body.slug } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.accept_description !== undefined
          ? { accept_description: body.accept_description }
          : {}),
        ...(body.category !== undefined ? { category: body.category } : {}),
        ...(body.lifecycle !== undefined ? { lifecycle: body.lifecycle } : {}),
      },
      db,
    );
    if ("workflow" in result && result.workflow) {
      return c.json(await serializeOne(result.workflow, principal.tenant_id, db), 200);
    }
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
    const ok = await svc.deleteWorkflow(principal.tenant_id, id, principal.id, db, principal.kind);
    if (!ok) throw new NotFoundError("workflow");
    return c.body(null, 204);
  });
}
