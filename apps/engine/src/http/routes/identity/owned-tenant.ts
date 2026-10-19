import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { browserSessionForPrincipal } from "../../../auth/index.ts";
import {
  consumeIdentityRecovery,
  IdentityRecoveryError,
  readOwnedTenant,
  requestOwnedTenantDeletion,
  restoreOwnedTenant,
  SelfServiceIdentityError,
  TenantLifecycleError,
} from "../../../identity/index.ts";
import { ForbiddenError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";

const refused = {
  description: "Verified owner browser identity or recovery proof required",
  content: { "application/json": { schema: ErrorSchema } },
};
const ownedTenant = z.object({
  id: z.uuid(),
  display_name: z.string(),
  status: z.enum(["active", "suspended", "pending_deletion"]),
  deletion_requested_at: z.string().datetime().nullable(),
  deletion_scheduled_for: z.string().datetime().nullable(),
});
const readRoute = createRoute({
  method: "get",
  path: "/v1/identity/owned-tenant",
  tags: ["identity"],
  summary: "Read the verified browser identity's own hosted tenant",
  security: [{ browserSession: [] }],
  responses: {
    200: {
      description: "Own tenant status",
      content: { "application/json": { schema: z.object({ tenant: ownedTenant.nullable() }) } },
    },
    403: refused,
  },
});
const deleteRoute = createRoute({
  method: "post",
  path: "/v1/identity/owned-tenant/deletion",
  tags: ["identity"],
  summary: "Request deletion of the current owned hosted tenant after seven days",
  security: [{ browserSession: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ confirmation: z.string().min(1).max(200) }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Tenant blocked immediately; deletion scheduled",
      content: {
        "application/json": {
          schema: z.object({
            tenant_id: z.uuid(),
            status: z.literal("pending_deletion"),
            deletion_scheduled_for: z.string().datetime(),
          }),
        },
      },
    },
    403: refused,
  },
});
const restoreRoute = createRoute({
  method: "post",
  path: "/v1/identity/owned-tenant/restore",
  tags: ["identity"],
  summary: "Restore the owner tenant using a fresh one-time identity recovery proof",
  description:
    "Requires the separate HttpOnly recovery cookie and X-Subkit-Recovery-CSRF from GET /v1/identity/recovery. Does not issue or reactivate tenant credentials.",
  responses: {
    200: {
      description: "Tenant restored; sign in again",
      content: {
        "application/json": {
          schema: z.object({ tenant_id: z.uuid(), status: z.literal("active") }),
        },
      },
    },
    403: refused,
  },
});

function rethrowLifecycle(error: unknown): never {
  if (
    error instanceof SelfServiceIdentityError ||
    error instanceof TenantLifecycleError ||
    error instanceof IdentityRecoveryError
  )
    throw new ForbiddenError(error.code);
  throw error;
}
export function registerOwnedTenantRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(readRoute, async (c) => {
    const principal = requireAuth(c);
    const proof = await browserSessionForPrincipal(c.req.raw, principal);
    if (!proof || principal.product_id)
      throw new ForbiddenError("verified_browser_identity_required");
    try {
      const tenant = await readOwnedTenant(proof, c.get("db"));
      c.header("cache-control", "no-store");
      return c.json(
        {
          tenant: tenant
            ? {
                ...tenant,
                deletion_requested_at: tenant.deletion_requested_at?.toISOString() ?? null,
                deletion_scheduled_for: tenant.deletion_scheduled_for?.toISOString() ?? null,
              }
            : null,
        },
        200,
      );
    } catch (error) {
      return rethrowLifecycle(error);
    }
  });
  app.openapi(deleteRoute, async (c) => {
    const principal = requireAuth(c);
    const proof = await browserSessionForPrincipal(c.req.raw, principal);
    if (!proof || principal.product_id)
      throw new ForbiddenError("verified_browser_identity_required");
    try {
      const result = await requestOwnedTenantDeletion(
        { ...proof, confirmation: c.req.valid("json").confirmation },
        c.get("db"),
      );
      c.header("cache-control", "no-store");
      return c.json(
        { ...result, deletion_scheduled_for: result.deletion_scheduled_for.toISOString() },
        200,
      );
    } catch (error) {
      return rethrowLifecycle(error);
    }
  });
  app.openapi(restoreRoute, async (c) => {
    try {
      const result = await consumeIdentityRecovery(c.req.raw, restoreOwnedTenant, c.get("db"));
      c.header("cache-control", "no-store");
      return c.json(result, 200);
    } catch (error) {
      return rethrowLifecycle(error);
    }
  });
}
