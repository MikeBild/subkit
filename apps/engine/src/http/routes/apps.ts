import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import {
  AppIdParam,
  AppListResponseSchema,
  AppUserParam,
  AppViewSchema,
  ErasedAppUserSchema,
} from "../../api/app-schemas.ts";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { policy } from "../../auth/index.ts";
import { getConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { type AppTenant, eraseAppUser, getApp, listApps } from "../../execution/index.ts";
import { getTenant } from "../../identity/index.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { enforce } from "../middleware/policy.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const errorResponses = {
  401: { description: "Unauthenticated", content: { "application/json": { schema: ErrorSchema } } },
  403: {
    description: "Missing settings:read; product principals are always refused",
    content: { "application/json": { schema: ErrorSchema } },
  },
};

const listRoute = createRoute({
  method: "get",
  path: "/v1/apps",
  tags: ["identity"],
  summary: "List the apps visible to the caller's workspace",
  description:
    "Read-only view derived from products settings, sign-in providers, workflows, signed-in identities and the caller budget ledger. An app is visible when a provider of this workspace, a workflow of this workspace or a signed-in identity carries its product_id, or when its assistant workflow belongs to this workspace. Changes go through settings revisions.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Apps of the workspace",
      content: { "application/json": { schema: AppListResponseSchema } },
    },
    ...errorResponses,
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/v1/apps/{id}",
  tags: ["identity"],
  summary: "Read one app with its sign-in, workflows, readiness checks and today's budget",
  security: [{ bearerAuth: [] }],
  request: { params: AppIdParam },
  responses: {
    200: { description: "The app", content: { "application/json": { schema: AppViewSchema } } },
    ...errorResponses,
    404: {
      description: "No app with this id is visible to the workspace",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const eraseUserRoute = createRoute({
  method: "delete",
  path: "/v1/apps/{id}/users/{user_id}",
  tags: ["identity"],
  summary: "Erase one app user's data in SubKit (irreversible)",
  description:
    "Removes SubKit's own data about this person for this app: sign-in links, budget units, sessions and API keys are deleted or revoked, the account is anonymised, tokens issued before the erasure are refused (a new sign-in at the provider creates a new, empty app user) and the subject is removed from execution caller context. The account at the sign-in provider is untouched. Needs identity:write and an administrator; product principals are refused. A user who also has sign-in links to another app or to SubKit itself is refused with 409 and left unchanged. A repeated request answers 404.",
  security: [{ bearerAuth: [] }],
  request: { params: AppUserParam },
  responses: {
    200: {
      description: "The user was erased",
      content: { "application/json": { schema: ErasedAppUserSchema } },
    },
    ...errorResponses,
    409: {
      description: "The user also has access outside this app; nothing was changed",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "No such user in this app (also after it was already erased)",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

async function tenantOf(db: Db, tenant_id: string): Promise<AppTenant> {
  const tenant = await getTenant(tenant_id, db);
  if (!tenant) throw new NotFoundError("tenant");
  return { tenant_id, tenant_slug: tenant.slug };
}

export function registerAppRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/apps", requirePermission("settings:read"));
  app.use("/v1/apps/*", requirePermission("settings:read"));
  app.use("/v1/apps/:id/users/:user_id", async (c, next) => {
    if (c.req.method !== "DELETE") return next();
    return requirePermission("identity:write", () => ({
      type: "user",
      id: c.req.param("user_id"),
    }))(c, next);
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const items = await listApps(db, await tenantOf(db, principal.tenant_id), getConfig());
    return c.json({ items }, 200);
  });

  app.openapi(getRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const view = await getApp(
      db,
      await tenantOf(db, principal.tenant_id),
      getConfig(),
      c.req.valid("param").id,
    );
    if (!view) throw new NotFoundError("app");
    return c.json(view, 200);
  });

  app.openapi(eraseUserRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id, user_id } = c.req.valid("param");
    enforce(
      principal,
      policy.adminOnly(principal),
      { resource_type: "user", resource_id: user_id },
      db,
    );
    const erased = await eraseAppUser(
      db,
      await tenantOf(db, principal.tenant_id),
      { kind: principal.kind, id: principal.id },
      id,
      user_id,
    );
    if (!erased) throw new NotFoundError("app user");
    if ("kept" in erased)
      throw new ConflictError(
        "This user also has access outside this app (another app or a SubKit sign-in); erasing would remove that access too, so nothing was changed",
        { reason: erased.reason },
      );
    return c.json(erased, 200);
  });
}
