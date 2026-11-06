import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import { bindProviderIdentityOperation } from "../../../api/operations/identity-users.ts";
import {
  IdentityMigrationError,
  IdentityMigrationInput,
  migrateProviderIdentity,
} from "../../../identity/index.ts";
import { HttpError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";

const migrationRoute = createRoute({
  method: "post",
  path: "/v1/identity/provider-identities/migration",
  tags: ["identity"],
  summary: "Preview or explicitly apply existing pinned identity bindings as global memberships",
  description:
    "Engine operator only. Omit reviewed_digest for a conflict report. Submit the exact returned digest to apply that reviewed state. Never merges accounts by email or creates a login session.",
  security: [{ bearerAuth: [] }, { browserSession: [] }],
  request: { body: { content: { "application/json": { schema: IdentityMigrationInput } } } },
  responses: {
    200: {
      description: "Migration preview or applied result",
      content: {
        "application/json": {
          schema: z.object({
            applied: z.boolean(),
            digest: z.string(),
            conflicts: z.array(z.string()),
            identity_id: z.string().uuid().nullable(),
            bindings: z.array(
              z.object({
                binding_id: z.string().uuid(),
                tenant_id: z.string().uuid(),
                user_id: z.string().uuid(),
                email: z.string(),
                role_id: z.string().uuid(),
                auth_identity_id: z.string().uuid().nullable(),
                user_status: z.string(),
                user_deleted_at: z.string().datetime().nullable(),
                tenant_status: z.string(),
                tenant_deleted_at: z.string().datetime().nullable(),
              }),
            ),
          }),
        },
      },
    },
    403: {
      description: "Operator required",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Reviewed state changed",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerProviderIdentityRoutes(app: OpenAPIHono<AppEnv>) {
  app.openapi(migrationRoute, async (c) => {
    const principal = requireAuth(c);
    try {
      const report = await migrateProviderIdentity(c.req.valid("json"), principal, c.get("db"));
      return c.json(
        {
          ...report,
          bindings: report.bindings.map((binding) => ({
            ...binding,
            user_deleted_at: binding.user_deleted_at?.toISOString() ?? null,
            tenant_deleted_at: binding.tenant_deleted_at?.toISOString() ?? null,
          })),
        },
        200,
      );
    } catch (error) {
      if (error instanceof IdentityMigrationError)
        throw new HttpError(error.code === "operator_required" ? 403 : 409, error.code, error.code);
      throw error;
    }
  });

  toHonoRoute(app, bindProviderIdentityOperation);
}
