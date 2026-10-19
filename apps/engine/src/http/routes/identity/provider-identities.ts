import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { readRequestSource } from "../../../audit/index.ts";
import { policy } from "../../../auth/index.ts";
import {
  bindProviderIdentity,
  IdentityMigrationError,
  IdentityMigrationInput,
  migrateProviderIdentity,
  ProviderIdentityBindingError,
} from "../../../identity/index.ts";
import { HttpError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { enforce } from "../../middleware/policy.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

const BindingBody = z
  .object({
    provider_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    subject: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (value) =>
          value.trim() === value &&
          !Array.from(value).some((char) => {
            const code = char.charCodeAt(0);
            return code < 32 || code === 127;
          }),
      ),
  })
  .strict();
const BindingResponse = z
  .object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    provider_id: z.string(),
    issuer_url: z.string(),
    product_id: z.string().nullable(),
    subject: z.string(),
    replayed: z.boolean(),
  })
  .strict()
  .openapi("ProviderIdentityBinding");
const route = createRoute({
  method: "post",
  path: "/v1/identity/users/{id}/provider-identities",
  tags: ["identity"],
  summary: "Bind a configured OIDC subject to an existing user",
  description:
    "Operator-only. Issuer, product and tenant derive from trusted provider configuration. Does not change roles or grants, reassign identities, or revoke existing sessions.",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam, body: { content: { "application/json": { schema: BindingBody } } } },
  responses: {
    200: {
      description: "Existing exact binding",
      content: { "application/json": { schema: BindingResponse } },
    },
    201: {
      description: "Binding created or legacy binding pinned",
      content: { "application/json": { schema: BindingResponse } },
    },
    400: {
      description: "Invalid or unavailable provider",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: {
      description: "Forbidden or provider tenant mismatch",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Active user unavailable",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Subject, owner, issuer or product conflict",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

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

  app.use(
    "/v1/identity/users/:id/provider-identities",
    requirePermission("identity:write", (c) => {
      const id = c.req.param("id");
      return id ? { type: "user", id } : undefined;
    }),
  );
  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    enforce(principal, policy.adminOnly(principal), { resource_type: "user", resource_id: id }, db);
    try {
      const result = await bindProviderIdentity(
        {
          tenant_id: principal.tenant_id,
          user_id: id,
          ...c.req.valid("json"),
          actor_id: principal.id,
          actor_kind: principal.kind,
          request_source: readRequestSource(c) ?? "api",
        },
        db,
      );
      if (!result.binding.issuer_url) throw new Error("identity binding issuer missing");
      const response = {
        id: result.binding.id,
        user_id: result.binding.user_id,
        provider_id: result.binding.provider_id,
        issuer_url: result.binding.issuer_url,
        product_id: result.binding.product_id,
        subject: result.binding.subject,
        replayed: result.replayed,
      };
      return c.json(response, result.replayed ? 200 : 201);
    } catch (error) {
      if (!(error instanceof ProviderIdentityBindingError)) throw error;
      const status =
        error.code === "provider_unavailable"
          ? 400
          : error.code === "provider_tenant_mismatch"
            ? 403
            : error.code === "user_unavailable"
              ? 404
              : 409;
      throw new HttpError(status, error.code, error.message);
    }
  });
}
