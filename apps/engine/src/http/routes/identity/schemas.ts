// Shared zod schemas for the identity routes.

import { z } from "@hono/zod-openapi";

export const TenantSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    display_name: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("Tenant");

export const UserSchema = z
  .object({
    id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    email: z.string(),
    role: z.enum(["admin", "member", "enduser"]),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("User");

export const SystemAccountSchema = z
  .object({
    id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("SystemAccount");

export const ApiKeySchema = z
  .object({
    id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    prefix: z.string(),
    scopes: z.array(z.string()),
    user_id: z.string().uuid().nullable(),
    system_account_id: z.string().uuid().nullable(),
    allowed_workflows: z.array(z.string()).nullable(),
    allowed_connectors: z.array(z.string()).nullable(),
    created_at: z.string(),
    last_used_at: z.string().nullable(),
    expires_at: z.string().nullable(),
    rotating_out_at: z.string().nullable(),
    rotated_from_id: z.string().uuid().nullable(),
    revoked_at: z.string().nullable(),
  })
  .openapi("ApiKey");

export const ApiKeyIssuedSchema = ApiKeySchema.extend({
  plaintext_key: z.string().describe("Only returned once at issue time. Store securely."),
}).openapi("ApiKeyIssued");

export const PortalTokenSchema = z
  .object({
    id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    enduser_ref: z.string(),
    prefix: z.string(),
    allowed_workflows: z.array(z.string()),
    expires_at: z.string(),
    revoked_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("PortalToken");

export const PortalTokenIssuedSchema = PortalTokenSchema.extend({
  plaintext_token: z.string(),
}).openapi("PortalTokenIssued");

export const ErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    trace_id: z.string().optional(),
    details: z.record(z.string(), z.any()).optional(),
  })
  .openapi("Error");

export const PaginationQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export const IdParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: "id", in: "path" } }),
});
