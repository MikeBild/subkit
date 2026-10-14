import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam, paginatedResponse } from "../../../api/common-schemas.ts";
import { policy } from "../../../auth/index.ts";
import * as identity from "../../../identity/index.ts";
import { BadRequestError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { enforce } from "../../middleware/policy.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { ApiKeyIssuedSchema, ApiKeySchema } from "./schemas.ts";

const ApiKeyListResponse = paginatedResponse(ApiKeySchema, "ApiKeyListResponse");

const IssueApiKeyBody = z
  .object({
    owner_kind: z.enum(["user", "system_account"]),
    owner_id: z.string().uuid(),
    name: z
      .string()
      .optional()
      .describe(
        'Operator-facing label, e.g. "claude-code". Useful when running one key per channel — a read-and-execute key for a browser client, an mcp:authoring key for a coding agent.',
      ),
    scopes: z.array(z.string()).optional(),
    allowed_workflows: z.array(z.string()).optional(),
    allowed_connectors: z.array(z.string()).optional(),
    expires_at: z.string().datetime().optional(),
  })
  .openapi("IssueApiKeyBody");

const RotateApiKeyBody = z
  .object({
    overlap_minutes: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60)
      .optional(),
  })
  .openapi("RotateApiKeyBody");

const RotateApiKeyResponse = z
  .object({
    old: ApiKeySchema,
    new: ApiKeyIssuedSchema,
  })
  .openapi("RotateApiKeyResponse");

const listRoute = createRoute({
  method: "get",
  path: "/v1/identity/api-keys",
  tags: ["identity"],
  summary: "List API keys",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ApiKeyListResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const issueRoute = createRoute({
  method: "post",
  path: "/v1/identity/api-keys",
  tags: ["identity"],
  summary: "Issue an API key",
  request: {
    body: { content: { "application/json": { schema: IssueApiKeyBody } } },
  },
  security: [{ bearerAuth: [] }],
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: ApiKeyIssuedSchema } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const rotateRoute = createRoute({
  method: "post",
  path: "/v1/identity/api-keys/{id}/rotate",
  tags: ["identity"],
  summary: "Rotate an API key",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: RotateApiKeyBody } } },
  },
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Rotated",
      content: { "application/json": { schema: RotateApiKeyResponse } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const revokeRoute = createRoute({
  method: "delete",
  path: "/v1/identity/api-keys/{id}",
  tags: ["identity"],
  summary: "Revoke an API key",
  request: { params: IdParam },
  security: [{ bearerAuth: [] }],
  responses: {
    204: { description: "Revoked" },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

function serialize(v: identity.ApiKeyView) {
  return {
    id: v.id,
    tenant_id: v.tenant_id,
    prefix: v.prefix,
    name: v.name,
    scopes: v.scopes,
    user_id: v.user_id,
    system_account_id: v.system_account_id,
    creator: v.creator,
    allowed_workflows: v.allowed_workflows,
    allowed_connectors: v.allowed_connectors,
    created_at: v.created_at.toISOString(),
    last_used_at: v.last_used_at ? v.last_used_at.toISOString() : null,
    expires_at: v.expires_at ? v.expires_at.toISOString() : null,
    rotating_out_at: v.rotating_out_at ? v.rotating_out_at.toISOString() : null,
    rotated_from_id: v.rotated_from_id,
    revoked_at: v.revoked_at ? v.revoked_at.toISOString() : null,
  };
}

export function registerApiKeyRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/identity/api-keys", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("api_key:read")(c, next);
    if (c.req.method === "POST") return requirePermission("api_key:write")(c, next);
    return next();
  });
  app.use("/v1/identity/api-keys/:id", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "DELETE") {
      return requirePermission("api_key:revoke", () => ({ type: "api_key", id }))(c, next);
    }
    return next();
  });
  app.use("/v1/identity/api-keys/:id/rotate", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("api_key:rotate", () => ({ type: "api_key", id }))(c, next);
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    enforce(principal, policy.adminReadOnly(principal), { resource_type: "api_key" }, db);
    const items = await identity.listApiKeys(principal.tenant_id, db);
    const filtered = principal.roles.includes("admin")
      ? items
      : items.filter((k) => principal.kind === "user" && k.user_id === principal.id);
    return c.json({ items: filtered.map(serialize) }, 200);
  });

  app.openapi(issueRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");

    const selfMatch =
      body.owner_kind === "user" && principal.kind === "user" && body.owner_id === principal.id;
    enforce(
      principal,
      policy.adminOrSelf(principal, selfMatch),
      {
        resource_type: "api_key",
        action: "issue",
      },
      db,
    );

    const expiresAt = body.expires_at ? new Date(body.expires_at) : undefined;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      throw new BadRequestError("expires_at is not a valid timestamp");
    }
    const result = await identity.issueApiKey(
      {
        tenant_id: principal.tenant_id,
        owner_kind: body.owner_kind,
        owner_id: body.owner_id,
        ...(body.name ? { name: body.name } : {}),
        ...(body.scopes ? { scopes: body.scopes } : {}),
        ...(body.allowed_workflows ? { allowed_workflows: body.allowed_workflows } : {}),
        ...(body.allowed_connectors ? { allowed_connectors: body.allowed_connectors } : {}),
        ...(expiresAt ? { expires_at: expiresAt } : {}),
        actor: { kind: principal.kind, id: principal.id },
      },
      db,
    );
    return c.json(
      {
        ...serialize(result.view),
        plaintext_key: result.plaintext,
      },
      201,
    );
  });

  app.openapi(rotateRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const existing = await identity.getApiKey(principal.tenant_id, id, db);
    if (!existing) throw new NotFoundError("api_key");
    const selfMatch = principal.kind === "user" && existing.user_id === principal.id;
    enforce(
      principal,
      policy.adminOrSelf(principal, selfMatch),
      {
        resource_type: "api_key",
        resource_id: id,
        action: "rotate",
      },
      db,
    );

    const result = await identity.rotateApiKey(
      {
        tenant_id: principal.tenant_id,
        id,
        ...(body.overlap_minutes !== undefined ? { overlap_minutes: body.overlap_minutes } : {}),
        actor: { kind: principal.kind, id: principal.id },
      },
      db,
    );
    if (!result) throw new NotFoundError("api_key");
    return c.json(
      {
        old: serialize(result.old),
        new: { ...serialize(result.new), plaintext_key: result.plaintext },
      },
      200,
    );
  });

  app.openapi(revokeRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const existing = await identity.getApiKey(principal.tenant_id, id, db);
    if (!existing) throw new NotFoundError("api_key");
    const selfMatch = principal.kind === "user" && existing.user_id === principal.id;
    enforce(
      principal,
      policy.adminOrSelf(principal, selfMatch),
      {
        resource_type: "api_key",
        resource_id: id,
        action: "revoke",
      },
      db,
    );
    const row = await identity.revokeApiKey(
      {
        tenant_id: principal.tenant_id,
        id,
        actor_kind: principal.kind,
        actor_id: principal.id,
      },
      db,
    );
    if (!row) throw new NotFoundError("api_key");
    return c.body(null, 204);
  });
}
