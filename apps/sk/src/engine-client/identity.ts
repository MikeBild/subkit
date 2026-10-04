import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";

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
  plaintext_token: string;
}

export interface InviteRedeemedWire {
  user_id: string;
  tenant_id: string;
  api_key: string;
  api_key_prefix: string;
}

export const identityMethods = {
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

  skBootstrap(this: EngineClient): Promise<components["schemas"]["SkBootstrap"]> {
    return this.request("GET", "/v1/sk/bootstrap");
  },

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

  listIdentityUsers(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/identity/users", undefined, query);
  },
  getIdentityUser(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/identity/users/${encodeURIComponent(id)}`);
  },
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
  redeemInvite(this: EngineClient, body: { token: string }): Promise<InviteRedeemedWire> {
    return this.request("POST", "/v1/identity/invites/redeem", body);
  },

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
