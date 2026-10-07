import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { readRequestSource } from "../../../audit/index.ts";
import { policy } from "../../../auth/index.ts";
import { bindProviderIdentity, ProviderIdentityBindingError } from "../../../identity/index.ts";
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

export function registerProviderIdentityRoutes(app: OpenAPIHono<AppEnv>) {
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
