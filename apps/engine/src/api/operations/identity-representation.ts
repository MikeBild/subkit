import { z } from "@hono/zod-openapi";
import type { InviteView } from "../../identity/provisioning.ts";
import type {
  ApiKeyView,
  createSystemAccount,
  getTenant,
  getUser,
  PortalTokenView,
} from "../../identity/service.ts";

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
    display_name: z.string().nullable(),
    role: z.string().nullable(),
    status: z.enum(["invited", "active", "disabled"]),
    oauth_connections: z.number().int().nonnegative(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("User");

const UserIdentitySchema = z
  .object({
    provider_id: z.string(),
    product_id: z.string().nullable(),
    last_seen_at: z.string(),
  })
  .openapi("UserIdentity");

export const UserDetailSchema = UserSchema.extend({
  groups: z
    .array(z.object({ id: z.string().uuid(), name: z.string() }))
    .nullable()
    .describe("Group memberships, or null when the caller cannot read RBAC membership."),
  identities: z
    .array(UserIdentitySchema)
    .describe(
      "Sign-in identities linked by an oidc or oidc_bearer provider; product_id names the app the identity signed in to.",
    ),
}).openapi("UserDetail");

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
    creator: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("user"), id: z.string().uuid() }),
        z.object({ kind: z.literal("system_account"), id: z.string().uuid() }),
        z.object({ kind: z.literal("system"), id: z.null() }),
      ])
      .nullable()
      .describe(
        "Typed creator of the key, or null when creator provenance is unavailable or unknown.",
      ),
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

type TenantRow = NonNullable<Awaited<ReturnType<typeof getTenant>>>;
type UserRow = NonNullable<Awaited<ReturnType<typeof getUser>>>;
type SystemAccountRow = NonNullable<Awaited<ReturnType<typeof createSystemAccount>>>;

export function serializeTenant(t: TenantRow) {
  return {
    id: t.id,
    slug: t.slug,
    display_name: t.display_name,
    created_at: t.created_at.toISOString(),
    updated_at: t.updated_at.toISOString(),
  };
}

export function serializeUser(u: UserRow, roleName: string | null, oauthConnections = 0) {
  return {
    id: u.id,
    tenant_id: u.tenant_id,
    email: u.email,
    display_name: u.display_name,
    role: roleName,
    status: u.status,
    oauth_connections: oauthConnections,
    created_at: u.created_at.toISOString(),
    updated_at: u.updated_at.toISOString(),
  };
}

export function serializeSystemAccount(s: SystemAccountRow) {
  return {
    id: s.id,
    tenant_id: s.tenant_id,
    name: s.name,
    description: s.description ?? null,
    created_at: s.created_at.toISOString(),
    updated_at: s.updated_at.toISOString(),
  };
}

export function serializeApiKey(v: ApiKeyView) {
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

export function serializePortalToken(p: PortalTokenView) {
  return {
    id: p.id,
    tenant_id: p.tenant_id,
    enduser_ref: p.enduser_ref,
    prefix: p.prefix,
    allowed_workflows: p.allowed_workflows,
    expires_at: p.expires_at.toISOString(),
    revoked_at: p.revoked_at ? p.revoked_at.toISOString() : null,
    created_at: p.created_at.toISOString(),
  };
}

export function serializeInvite(v: InviteView) {
  return {
    id: v.id,
    tenant_id: v.tenant_id,
    user_id: v.user_id,
    prefix: v.prefix,
    scopes: v.scopes,
    allowed_workflows: v.allowed_workflows,
    allowed_connectors: v.allowed_connectors,
    expires_at: v.expires_at.toISOString(),
    redeemed_at: v.redeemed_at ? v.redeemed_at.toISOString() : null,
    revoked_at: v.revoked_at ? v.revoked_at.toISOString() : null,
    created_by: v.created_by,
    created_at: v.created_at.toISOString(),
  };
}
