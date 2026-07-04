// Identity surfaces of the engine client: whoami / bootstrap, API
// keys, portal tokens, users, provisioning invites, system accounts,
// and tenants. Method group merged into `EngineClient` by
// `../engine-client.ts`.

import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";

// ---------- Identity provisioning wire types ----------
// Mirror `apps/engine/src/http/routes/identity/schemas.ts`
// (UserSchema, UserInviteSchema, UserInviteIssuedSchema,
// InviteRedeemedSchema). Kept structural (not Zod) so the CLI's tsc
// graph doesn't pull in @hono/zod-openapi.

export interface IdentityUserWire {
  id: string;
  tenant_id: string;
  email: string;
  role: "admin" | "member" | "enduser";
  status: "invited" | "active" | "disabled";
  created_at: string;
  updated_at: string;
}

export interface UserInviteWire {
  id: string;
  tenant_id: string;
  user_id: string;
  prefix: string;
  scopes: string[];
  allowed_workflows: string[] | null;
  allowed_connectors: string[] | null;
  expires_at: string;
  redeemed_at: string | null;
  revoked_at: string | null;
  created_by: string | null;
  created_at: string;
}

export interface UserInviteIssuedWire extends UserInviteWire {
  /** Returned exactly once at issue time; the engine never shows it again. */
  plaintext_token: string;
}

export interface InviteRedeemedWire {
  user_id: string;
  tenant_id: string;
  /** The invited user's personal API key. Returned exactly once. */
  api_key: string;
  api_key_prefix: string;
}

export const identityMethods = {
  // --------------------------- Identity ---------------------------
  whoami(this: EngineClient): Promise<{
    id: string;
    kind: "user" | "system_account";
    tenant_id: string;
    tenant_slug: string | null;
    email: string | null;
    role_name: string | null;
    provider: string;
  }> {
    return this.request("GET", "/v1/identity/whoami");
  },

  /**
   * Composite startup payload — replaces the per-permission rbac:can
   * fan-out the CLI used to issue at session start. Returns the
   * authenticated principal's whoami snapshot, the precomputed allow-set
   * for the well-known UX-gating permissions, the tenant snapshot, and
   * the most recent owned conversations.
   */
  skBootstrap(this: EngineClient): Promise<components["schemas"]["SkBootstrap"]> {
    // Return type is the generated OpenAPI schema — single source of
    // truth shared with `apps/sk/src/lib/bootstrap.ts`. Replaces a
    // 19-line hand-rolled inline type that was previously flagged as
    // a typo-drift hazard.
    return this.request("GET", "/v1/sk/bootstrap");
  },

  // -------------------- API Keys --------------------
  listApiKeys(this: EngineClient): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/identity/api-keys");
  },
  issueApiKey(this: EngineClient, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/identity/api-keys", body);
  },
  rotateApiKey(
    this: EngineClient,
    id: string,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/identity/api-keys/${encodeURIComponent(id)}/rotate`, body);
  },
  revokeApiKey(this: EngineClient, id: string): Promise<void> {
    return this.request("DELETE", `/v1/identity/api-keys/${encodeURIComponent(id)}`);
  },

  // -------------------- Portal Tokens --------------------
  listPortalTokens(this: EngineClient): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/identity/portal-tokens");
  },
  issuePortalToken(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/identity/portal-tokens", body);
  },
  revokePortalToken(this: EngineClient, id: string): Promise<void> {
    return this.request("DELETE", `/v1/identity/portal-tokens/${encodeURIComponent(id)}`);
  },

  // -------------------- Identity: Users --------------------
  listIdentityUsers(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/identity/users", undefined, query);
  },
  getIdentityUser(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/identity/users/${encodeURIComponent(id)}`);
  },
  /** Create a user in the caller's tenant. Mirrors the route's
   *  CreateUserBody (`{ email, role? }`). */
  createUser(
    this: EngineClient,
    body: {
      email: string;
      role?: "admin" | "member" | "enduser";
    },
  ): Promise<IdentityUserWire> {
    return this.request("POST", "/v1/identity/users", body);
  },
  patchIdentityUser(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/identity/users/${encodeURIComponent(id)}`, body);
  },
  deleteIdentityUser(this: EngineClient, id: string): Promise<void> {
    return this.request("DELETE", `/v1/identity/users/${encodeURIComponent(id)}`);
  },

  // -------------------- Identity: Invites --------------------
  /** Issue a single-use provisioning invite for an existing user.
   *  Returns the plaintext token ONCE (UserInviteIssuedWire). */
  createInvite(
    this: EngineClient,
    userId: string,
    body: {
      scopes?: string[];
      allowed_workflows?: string[];
      allowed_connectors?: string[];
      ttl_minutes?: number;
    } = {},
  ): Promise<UserInviteIssuedWire> {
    return this.request("POST", `/v1/identity/users/${encodeURIComponent(userId)}/invites`, body);
  },
  listInvites(
    this: EngineClient,
    query: { status?: "pending" | "redeemed" | "revoked" | "expired" } = {},
  ): Promise<{ items: UserInviteWire[] }> {
    return this.request("GET", "/v1/identity/invites", undefined, query);
  },
  revokeInvite(this: EngineClient, id: string): Promise<void> {
    return this.request("DELETE", `/v1/identity/invites/${encodeURIComponent(id)}`);
  },
  /**
   * Redeem an invite to mint the invited user's personal API key.
   * UNAUTHENTICATED: construct the client with an empty `api_key` so
   * `headers()` sends no Authorization header — the token in the body
   * is the proof. Returns the personal API key plaintext ONCE.
   */
  redeemInvite(this: EngineClient, body: { token: string }): Promise<InviteRedeemedWire> {
    return this.request("POST", "/v1/identity/invites/redeem", body);
  },

  // -------------------- Identity: System Accounts --------------------
  listSystemAccounts(this: EngineClient): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/identity/system-accounts");
  },
  createSystemAccount(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/identity/system-accounts", body);
  },
  deleteSystemAccount(this: EngineClient, id: string): Promise<void> {
    return this.request("DELETE", `/v1/identity/system-accounts/${encodeURIComponent(id)}`);
  },

  // -------------------- Identity: Tenants --------------------
  listIdentityTenants(
    this: EngineClient,
    query: Record<string, string | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/identity/tenants", undefined, query);
  },
  getIdentityTenant(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/identity/tenants/${encodeURIComponent(id)}`);
  },
};
