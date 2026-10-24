import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import {
  applyBoundaryProposals,
  CreateWorkflowDraftSchema,
  currentOrDraftDefinition,
  getWorkflowDraft,
  proposeBoundaries,
  recipeAuditMetadata,
  type SaveWorkflowDraftResult,
  saveWorkflowDraft,
  UpdateWorkflowDraftSchema,
  WorkflowDraftSchema,
  type WorkflowSpec,
} from "../../workflows/index.ts";
import { BadRequestError, ConflictError, HttpError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";
import { assertRecipeOrigin } from "./recipe-origin.ts";

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
    description: "Draft, active version or slug changed",
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
  responses: {
    201: draftResponse,
    ...failures,
    422: {
      description:
        "The recipe origin names no shipped recipe, or the definition was not built from it",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
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

const ProposalSchema = z
  .object({
    proposals: z.array(
      z.object({
        step_id: z.string(),
        boundary: z
          .object({
            variables: z.record(z.string(), z.unknown()),
            max_body_bytes: z.number().int(),
            max_calls: z.number().int(),
          })
          .optional(),
        s3_scope: z.object({ key_prefix: z.string(), max_bytes: z.number().int() }).optional(),
        evidence: z.object({
          observations: z.number().int(),
          sample: z.string(),
          newest_at: z.string(),
        }),
      }),
    ),
    unproposable: z.array(z.object({ step_id: z.string(), reason: z.string() })),
  })
  .openapi("WorkflowBoundaryProposals");

const proposals = createRoute({
  method: "get",
  path: "/v1/workflows/{id}/boundary-proposals",
  tags: ["workflows"],
  summary: "Read the boundaries SubKit derives from what each step has really done",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "Derived from execution history; nothing is changed",
      content: { "application/json": { schema: ProposalSchema } },
    },
    ...failures,
  },
});

const applyProposals = createRoute({
  method: "post",
  path: "/v1/workflows/{id}/boundary-proposals/apply",
  tags: ["workflows"],
  summary: "Write the derived boundaries into a new draft, activating nothing",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              expected_draft_version_id: z.string().uuid().nullable(),
              step_ids: z.array(z.string().min(1)).max(200).optional(),
            })
            .openapi("ApplyBoundaryProposalsBody"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "A new inert draft carrying the derived boundaries",
      content: {
        "application/json": {
          schema: z
            .object({
              draft: WorkflowDraftSchema,
              applied_step_ids: z.array(z.string()),
            })
            .openapi("ApplyBoundaryProposalsResponse"),
        },
      },
    },
    ...failures,
  },
});

function assertSpecOrigin(
  principal: ReturnType<typeof requireAuth>,
  spec: WorkflowSpec | undefined,
): void {
  if (spec?.origin !== "person") return;
  if (principal.kind === "user" && principal.auth_source?.kind === "browser_session") return;
  throw new HttpError(
    403,
    "human_confirmation_required",
    "only a signed-in person can state a spec as their own; send origin chat or derived",
  );
}

function unwrap(result: SaveWorkflowDraftResult) {
  if (result.draft) return result.draft;
  if (result.code === "not_found") throw new NotFoundError("workflow");
  if (result.code === "invalid_definition") throw new BadRequestError(result.errors.join("; "));
  throw new ConflictError(result.errors.join("; "), { reason: result.code, ...result.details });
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
    assertSpecOrigin(principal, body.spec);
    if (body.recipe) assertRecipeOrigin(body.recipe, body.definition);
    const result = await saveWorkflowDraft(
      {
        tenant_id: principal.tenant_id,
        actor_id: principal.id,
        actor_type: principal.kind,
        def: body.definition,
        ...(body.spec !== undefined ? { spec: body.spec } : {}),
        request_source: c.get("request_source") ?? "api",
        ...(body.category !== undefined ? { metadata: { category: body.category } } : {}),
        ...(body.recipe ? { audit_metadata: recipeAuditMetadata(body.recipe) } : {}),
      },
      c.get("db"),
    );
    return c.json(unwrap(result), 201);
  });
  app.openapi(update, async (c) => {
    const principal = requireAuth(c);
    const body = c.req.valid("json");
    assertSpecOrigin(principal, body.spec);
    const result = await saveWorkflowDraft(
      {
        tenant_id: principal.tenant_id,
        actor_id: principal.id,
        actor_type: principal.kind,
        workflow_id: c.req.valid("param").id,
        expected_draft_version_id: body.expected_draft_version_id,
        ...(body.expected_current_version_id !== undefined
          ? { expected_current_version_id: body.expected_current_version_id }
          : {}),
        def: body.definition,
        ...(body.spec !== undefined ? { spec: body.spec } : {}),
        ...(body.category !== undefined ? { metadata: { category: body.category } } : {}),
        request_source: c.get("request_source") ?? "api",
      },
      c.get("db"),
    );
    return c.json(unwrap(result), 200);
  });
  app.use("/v1/workflows/:id/boundary-proposals", async (c, next) => {
    const resource = () => ({ type: "workflow", id: c.req.param("id") });
    return requirePermission("workflow:read", resource)(c, next);
  });
  app.use("/v1/workflows/:id/boundary-proposals/apply", async (c, next) => {
    const resource = () => ({ type: "workflow", id: c.req.param("id") });
    return requirePermission("workflow:write", resource)(c, next);
  });
  app.openapi(proposals, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const id = c.req.valid("param").id;
    const definition = await currentOrDraftDefinition(principal.tenant_id, id, db);
    if (!definition) throw new NotFoundError("workflow");
    const derived = await proposeBoundaries(db, {
      tenant_id: principal.tenant_id,
      workflow_id: id,
      definition,
    });
    return c.json(derived, 200);
  });
  app.openapi(applyProposals, async (c) => {
    const principal = requireAuth(c);
    const body = c.req.valid("json");
    const result = await applyBoundaryProposals(
      {
        tenant_id: principal.tenant_id,
        workflow_id: c.req.valid("param").id,
        expected_draft_version_id: body.expected_draft_version_id,
        ...(body.step_ids ? { step_ids: body.step_ids } : {}),
        actor_id: principal.id,
        actor_type: principal.kind,
        request_source: c.get("request_source") ?? "api",
      },
      c.get("db"),
    );
    if (!("applied_step_ids" in result)) {
      if ("code" in result && result.code === "nothing_to_apply")
        throw new BadRequestError(
          "nothing could be derived for this workflow: its steps have no recorded history to read",
        );
      unwrap(result as SaveWorkflowDraftResult);
      throw new BadRequestError("boundary proposals could not be applied");
    }
    return c.json({ draft: result.draft, applied_step_ids: result.applied_step_ids }, 200);
  });
  app.openapi(get, async (c) => {
    const principal = requireAuth(c);
    const draft = await getWorkflowDraft(principal.tenant_id, c.req.valid("param").id, c.get("db"));
    if (!draft) throw new NotFoundError("workflow draft");
    return c.json(draft, 200);
  });
}
