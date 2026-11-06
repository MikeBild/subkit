import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import {
  lifecycleErrorCode,
  OWNED_TENANT_REFUSED,
  readOwnedTenantOperation,
  requestOwnedTenantDeletionOperation,
} from "../../../api/operations/owned-tenant.ts";
import { consumeIdentityRecovery, restoreOwnedTenant } from "../../../identity/index.ts";
import { ForbiddenError } from "../../errors.ts";
import type { AppEnv } from "../../openapi.ts";

const restoreRoute = createRoute({
  method: "post",
  path: "/v1/identity/owned-tenant/restore",
  tags: ["identity"],
  summary: "Restore the owner tenant using a fresh one-time identity recovery proof",
  description:
    "Requires the separate HttpOnly recovery cookie and X-Subkit-Recovery-CSRF from GET /v1/identity/recovery. Does not issue or reactivate tenant credentials.",
  request: {
    headers: z.object({
      "x-subkit-recovery-csrf": z
        .string()
        .optional()
        .openapi({
          param: {
            required: true,
            description:
              "csrf_token from GET /v1/identity/recovery; a missing or stale token is refused with 403.",
          },
        }),
    }),
  },
  responses: {
    200: {
      description: "Tenant restored; sign in again",
      content: {
        "application/json": {
          schema: z.object({ tenant_id: z.uuid(), status: z.literal("active") }),
        },
      },
    },
    403: {
      description: OWNED_TENANT_REFUSED,
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerOwnedTenantRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, readOwnedTenantOperation);
  toHonoRoute(app, requestOwnedTenantDeletionOperation);
  app.openapi(restoreRoute, async (c) => {
    try {
      const result = await consumeIdentityRecovery(c.req.raw, restoreOwnedTenant, c.get("db"));
      c.header("cache-control", "no-store");
      return c.json(result, 200);
    } catch (error) {
      const code = lifecycleErrorCode(error);
      if (code) throw new ForbiddenError(code);
      throw error;
    }
  });
}
