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
    role: z.string().nullable(),
    status: z.enum(["invited", "active", "disabled"]),
    oauth_connections: z.number().int().nonnegative(),
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
    name: z
      .string()
      .nullable()
      .describe("Operator-facing label, or null for keys issued before labels were kept."),
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

export const UserInviteSchema = z
  .object({
    id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    user_id: z.string().uuid(),
    prefix: z.string(),
    scopes: z.array(z.string()),
    allowed_workflows: z.array(z.string()).nullable(),
    allowed_connectors: z.array(z.string()).nullable(),
    expires_at: z.string(),
    redeemed_at: z.string().nullable(),
    revoked_at: z.string().nullable(),
    created_by: z.string().uuid().nullable(),
    created_at: z.string(),
  })
  .openapi("UserInvite");

export const UserInviteIssuedSchema = UserInviteSchema.extend({
  plaintext_token: z
    .string()
    .describe(
      "Only returned once at issue time. Hand to the invited user; the engine never shows it again.",
    ),
}).openapi("UserInviteIssued");

export const InviteRedeemedSchema = z
  .object({
    user_id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    api_key: z.string().describe("The invited user's personal API key. Returned exactly once."),
    api_key_prefix: z.string(),
  })
  .openapi("InviteRedeemed");
