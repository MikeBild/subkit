import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";
import type { ApiBody, ApiQuery } from "./http.ts";

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
  async whoami(this: EngineClient): Promise<{
    id: string;
    kind: "user" | "system_account";
    tenant_id: string;
    tenant_slug: string | null;
    email: string | null;
    role_name: string | null;
    provider: string;
    product_id: string | null;
  }> {
    const { data } = await this.api.GET("/v1/identity/whoami");
    return data as {
      id: string;
      kind: "user" | "system_account";
      tenant_id: string;
      tenant_slug: string | null;
      email: string | null;
      role_name: string | null;
      provider: string;
      product_id: string | null;
    };
  },

  async skBootstrap(this: EngineClient): Promise<components["schemas"]["SkBootstrap"]> {
    const { data } = await this.api.GET("/v1/sk/bootstrap");
    return data as components["schemas"]["SkBootstrap"];
  },

  async listApiKeys(this: EngineClient): Promise<{ items: Record<string, unknown>[] }> {
    const { data } = await this.api.GET("/v1/identity/api-keys");
    return data as { items: Record<string, unknown>[] };
  },
  async issueApiKey(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/identity/api-keys", {
      body: body as ApiBody<"/v1/identity/api-keys", "post">,
    });
    return data as Record<string, unknown>;
  },
  async rotateApiKey(
    this: EngineClient,
    id: string,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/identity/api-keys/{id}/rotate", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/identity/api-keys/{id}/rotate", "post">,
    });
    return data as Record<string, unknown>;
  },
  async revokeApiKey(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/identity/api-keys/{id}", { params: { path: { id } } });
  },

  async listPortalTokens(this: EngineClient): Promise<{ items: Record<string, unknown>[] }> {
    const { data } = await this.api.GET("/v1/identity/portal-tokens");
    return data as { items: Record<string, unknown>[] };
  },
  async issuePortalToken(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/identity/portal-tokens", {
      body: body as ApiBody<"/v1/identity/portal-tokens", "post">,
    });
    return data as Record<string, unknown>;
  },
  async revokePortalToken(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/identity/portal-tokens/{id}", { params: { path: { id } } });
  },

  async listIdentityUsers(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    const { data } = await this.api.GET("/v1/identity/users", {
      params: { query: query as ApiQuery<"/v1/identity/users", "get"> },
    });
    return data as { items: Record<string, unknown>[] };
  },
  async getIdentityUser(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    const { data } = await this.api.GET("/v1/identity/users/{id}", { params: { path: { id } } });
    return data as Record<string, unknown>;
  },
  async createUser(
    this: EngineClient,
    body: {
      email: string;
      role?: "admin" | "member" | "enduser";
    },
  ): Promise<IdentityUserWire> {
    const { data } = await this.api.POST("/v1/identity/users", {
      body: body as ApiBody<"/v1/identity/users", "post">,
    });
    return data as IdentityUserWire;
  },
  async patchIdentityUser(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.PATCH("/v1/identity/users/{id}", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/identity/users/{id}", "patch">,
    });
    return data as Record<string, unknown>;
  },
  async deleteIdentityUser(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/identity/users/{id}", { params: { path: { id } } });
  },

  async createInvite(
    this: EngineClient,
    userId: string,
    body: {
      scopes?: string[];
      allowed_workflows?: string[];
      allowed_connectors?: string[];
      ttl_minutes?: number;
    } = {},
  ): Promise<UserInviteIssuedWire> {
    const { data } = await this.api.POST("/v1/identity/users/{id}/invites", {
      params: { path: { id: userId } },
      body: body as ApiBody<"/v1/identity/users/{id}/invites", "post">,
    });
    return data as UserInviteIssuedWire;
  },
  async listInvites(
    this: EngineClient,
    query: { status?: "pending" | "redeemed" | "revoked" | "expired" } = {},
  ): Promise<{ items: UserInviteWire[] }> {
    const { data } = await this.api.GET("/v1/identity/invites", {
      params: { query: query as ApiQuery<"/v1/identity/invites", "get"> },
    });
    return data as { items: UserInviteWire[] };
  },
  async revokeInvite(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/identity/invites/{id}", { params: { path: { id } } });
  },
  async redeemInvite(this: EngineClient, body: { token: string }): Promise<InviteRedeemedWire> {
    const { data } = await this.api.POST("/v1/identity/invites/redeem", {
      body: body as ApiBody<"/v1/identity/invites/redeem", "post">,
    });
    return data as InviteRedeemedWire;
  },

  async listSystemAccounts(this: EngineClient): Promise<{ items: Record<string, unknown>[] }> {
    const { data } = await this.api.GET("/v1/identity/system-accounts");
    return data as { items: Record<string, unknown>[] };
  },
  async createSystemAccount(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/identity/system-accounts", {
      body: body as ApiBody<"/v1/identity/system-accounts", "post">,
    });
    return data as Record<string, unknown>;
  },
  async deleteSystemAccount(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/identity/system-accounts/{id}", { params: { path: { id } } });
  },

  listIdentityTenants(
    this: EngineClient,
    query: Record<string, string | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/identity/tenants", undefined, query);
  },
  async getIdentityTenant(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    const { data } = await this.api.GET("/v1/identity/tenants/{id}", { params: { path: { id } } });
    return data as Record<string, unknown>;
  },
};
