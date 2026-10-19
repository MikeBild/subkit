import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import * as svc from "../../workflows/index.ts";
import { BadRequestError, HttpError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";
import { serializeOne, WorkflowDetailSchema } from "./workflow-representation.ts";

const VersionSchema = z
  .object({
    id: z.string(),
    workflow_id: z.string(),
    version: z.number(),
    note: z.string().nullable(),
    created_at: z.string(),
    dag: z.unknown(),
    invalid: z.boolean(),
    author: z.object({ kind: z.enum(["user", "system_account"]), id: z.string() }).nullable(),
    checksum: z.string(),
  })
  .openapi("WorkflowVersion");

const VersionListResponse = z
  .object({
    items: z.array(VersionSchema),
    total: z.number().int().nonnegative(),
  })
  .openapi("WorkflowVersionListResponse");

const IdVersionParam = z.object({ id: z.string().uuid(), version: z.string() });

const historyRoute = createRoute({
  method: "get",
  path: "/v1/workflows/{id}/history",
  tags: ["workflows"],
  summary: "List workflow versions, newest first",
  description:
    "One page of the workflow's versions, newest first, each with its stored definition. `total` is the size of the whole history: page with `limit` and `offset` until you have that many.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    query: z.object({
      limit: z.coerce
        .number()
        .int()
        .positive()
        .max(svc.WORKFLOW_VERSION_LIST_MAX_LIMIT)
        .optional()
        .describe(
          `Page size. Defaults to ${svc.WORKFLOW_VERSION_LIST_DEFAULT_LIMIT}, at most ${svc.WORKFLOW_VERSION_LIST_MAX_LIMIT}.`,
        ),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
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
    200: { description: "OK", content: { "application/json": { schema: WorkflowDetailSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    422: {
      description: "The version no longer validates against the current workflow schema",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerWorkflowVersionRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/workflows/:id/history", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("workflow:read", () => ({ type: "workflow", id }))(c, next);
  });
  app.use("/v1/workflows/:id/restore/:version", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("workflow:restore", () => ({ type: "workflow", id }))(c, next);
  });

  app.openapi(historyRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    const { rows, total } = await svc.listWorkflowVersions(
      principal.tenant_id,
      id,
      {
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      },
      db,
    );
    return c.json(
      {
        items: rows.map((v) => ({
          id: v.id,
          workflow_id: v.workflow_id,
          version: v.version,
          note: v.note,
          created_at: v.created_at.toISOString(),
          dag: v.dag,
          invalid: v.invalid,
          author: v.author,
          checksum: v.checksum,
        })),
        total,
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
    let wf: svc.WorkflowView | null;
    try {
      wf = await svc.restoreWorkflowVersion(
        principal.tenant_id,
        id,
        v,
        principal.id,
        db,
        principal.kind,
      );
    } catch (error) {
      if (!(error instanceof svc.VersionNotRestorableError)) throw error;
      throw new HttpError(422, error.code, error.message, {
        hint: "Restore a version that GET /v1/workflows/{id}/history does not mark invalid, or save the definition again in the current format.",
        details: { version: error.version, issues: error.issues },
      });
    }
    if (!wf) throw new NotFoundError("workflow_version");
    return c.json(await serializeOne(wf, principal.tenant_id, db), 200);
  });
}
