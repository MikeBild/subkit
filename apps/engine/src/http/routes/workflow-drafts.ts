import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";

import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import {
  CreateWorkflowDraftSchema,
  getWorkflowDraft,
  saveWorkflowDraft,
  type SaveWorkflowDraftResult,
  UpdateWorkflowDraftSchema,
  WorkflowDraftSchema,
} from "../../workflows/index.ts";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const failures = {
  400: { description: "Invalid draft", content: { "application/json": { schema: ErrorSchema } } },
  401: {
    description: "Authentication required",
    content: { "application/json": { schema: ErrorSchema } },
  },
  403: {
    description: "Permission denied",
    content: { "application/json": { schema: ErrorSchema } },
  },
  404: { description: "Draft not found", content: { "application/json": { schema: ErrorSchema } } },
  409: {
    description: "Draft or slug changed",
    content: { "application/json": { schema: ErrorSchema } },
  },
};
const draftResponse = {
  description: "Inert draft; no activation or execution authority",
  content: { "application/json": { schema: WorkflowDraftSchema } },
};
const create = createRoute({
  method: "post",
  path: "/v1/workflows/drafts",
  tags: ["workflows"],
  summary: "Save a new inert workflow draft without activating triggers",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: CreateWorkflowDraftSchema } } } },
  responses: { 201: draftResponse, ...failures },
});
const update = createRoute({
  method: "put",
  path: "/v1/workflows/{id}/draft",
  tags: ["workflows"],
  summary: "Save a draft version without changing the active workflow",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: UpdateWorkflowDraftSchema } } },
  },
  responses: { 200: draftResponse, ...failures },
});
const get = createRoute({
  method: "get",
  path: "/v1/workflows/{id}/draft",
  tags: ["workflows"],
  summary: "Read the exact pending draft, separately from the active version",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: { 200: draftResponse, ...failures },
});

function unwrap(result: SaveWorkflowDraftResult) {
  if (result.draft) return result.draft;
  if (result.code === "not_found") throw new NotFoundError("workflow");
  if (result.code === "invalid_definition") throw new BadRequestError(result.errors.join("; "));
  throw new ConflictError(result.errors.join("; "), { reason: result.code });
}

export function registerWorkflowDraftRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/workflows/drafts", requirePermission("workflow:write"));
  app.use("/v1/workflows/:id/draft", async (c, next) => {
    const resource = () => ({ type: "workflow", id: c.req.param("id") });
    if (c.req.method === "GET") return requirePermission("workflow:read", resource)(c, next);
    return requirePermission("workflow:write", resource)(c, next);
  });
  app.openapi(create, async (c) => {
    const principal = requireAuth(c);
    const body = c.req.valid("json");
    const result = await saveWorkflowDraft(
      {
        tenant_id: principal.tenant_id,
        actor_id: principal.id,
        actor_type: principal.kind,
        def: body.definition,
        request_source: c.get("request_source") ?? "api",
      },
      c.get("db"),
    );
    return c.json(unwrap(result), 201);
  });
  app.openapi(update, async (c) => {
    const principal = requireAuth(c);
    const body = c.req.valid("json");
    const result = await saveWorkflowDraft(
      {
        tenant_id: principal.tenant_id,
        actor_id: principal.id,
        actor_type: principal.kind,
        workflow_id: c.req.valid("param").id,
        expected_draft_version_id: body.expected_draft_version_id,
        def: body.definition,
        request_source: c.get("request_source") ?? "api",
      },
      c.get("db"),
    );
    return c.json(unwrap(result), 200);
  });
  app.openapi(get, async (c) => {
    const principal = requireAuth(c);
    const draft = await getWorkflowDraft(principal.tenant_id, c.req.valid("param").id, c.get("db"));
    if (!draft) throw new NotFoundError("workflow draft");
    return c.json(draft, 200);
  });
}
