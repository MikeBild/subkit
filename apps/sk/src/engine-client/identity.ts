import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";
import type { ApiQuery } from "./http.ts";

type Schemas = components["schemas"];

export type IdentityUserWire = Schemas["User"];
export type UserInviteWire = Schemas["UserInvite"];
export type UserInviteIssuedWire = Schemas["UserInviteIssued"];
export type InviteRedeemedWire = Schemas["InviteRedeemed"];

export const identityMethods = {
  async whoami(this: EngineClient): Promise<Schemas["Whoami"]> {
    const { data } = await this.api.GET("/v1/identity/whoami");
    return data as Schemas["Whoami"];
  },

  async skBootstrap(this: EngineClient): Promise<Schemas["SkBootstrap"]> {
    const { data } = await this.api.GET("/v1/sk/bootstrap");
    return data as Schemas["SkBootstrap"];
  },

  async listApiKeys(this: EngineClient): Promise<Schemas["ApiKeyListResponse"]> {
    const { data } = await this.api.GET("/v1/identity/api-keys");
    return data as Schemas["ApiKeyListResponse"];
  },
  async issueApiKey(
    this: EngineClient,
    body: Schemas["IssueApiKeyBody"],
  ): Promise<Schemas["ApiKeyIssued"]> {
    const { data } = await this.api.POST("/v1/identity/api-keys", { body });
    return data as Schemas["ApiKeyIssued"];
  },
  async rotateApiKey(
    this: EngineClient,
    id: string,
    body: Schemas["RotateApiKeyBody"] = {},
  ): Promise<Schemas["RotateApiKeyResponse"]> {
    const { data } = await this.api.POST("/v1/identity/api-keys/{id}/rotate", {
      params: { path: { id } },
      body,
    });
    return data as Schemas["RotateApiKeyResponse"];
  },
  async revokeApiKey(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/identity/api-keys/{id}", { params: { path: { id } } });
  },

  async listPortalTokens(this: EngineClient): Promise<Schemas["PortalTokenListResponse"]> {
    const { data } = await this.api.GET("/v1/identity/portal-tokens");
    return data as Schemas["PortalTokenListResponse"];
  },
  async issuePortalToken(
    this: EngineClient,
    body: Schemas["IssuePortalTokenBody"],
  ): Promise<Schemas["PortalTokenIssued"]> {
    const { data } = await this.api.POST("/v1/identity/portal-tokens", { body });
    return data as Schemas["PortalTokenIssued"];
  },
  async revokePortalToken(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/identity/portal-tokens/{id}", { params: { path: { id } } });
  },

  async listIdentityUsers(
    this: EngineClient,
    query: ApiQuery<"/v1/identity/users", "get"> = {},
  ): Promise<Schemas["UserListResponse"]> {
    const { data } = await this.api.GET("/v1/identity/users", { params: { query } });
    return data as Schemas["UserListResponse"];
  },
  async getIdentityUser(this: EngineClient, id: string): Promise<Schemas["UserDetail"]> {
    const { data } = await this.api.GET("/v1/identity/users/{id}", { params: { path: { id } } });
    return data as Schemas["UserDetail"];
  },
  async createUser(this: EngineClient, body: Schemas["CreateUserBody"]): Promise<IdentityUserWire> {
    const { data } = await this.api.POST("/v1/identity/users", { body });
    return data as IdentityUserWire;
  },
  async patchIdentityUser(
    this: EngineClient,
    id: string,
    body: Schemas["UpdateUserBody"],
  ): Promise<IdentityUserWire> {
    const { data } = await this.api.PATCH("/v1/identity/users/{id}", {
      params: { path: { id } },
      body,
    });
    return data as IdentityUserWire;
  },
  async deleteIdentityUser(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/identity/users/{id}", { params: { path: { id } } });
  },

  async createInvite(
    this: EngineClient,
    userId: string,
    body: Schemas["CreateInviteBody"] = {},
  ): Promise<UserInviteIssuedWire> {
    const { data } = await this.api.POST("/v1/identity/users/{id}/invites", {
      params: { path: { id: userId } },
      body,
    });
    return data as UserInviteIssuedWire;
  },
  async listInvites(
    this: EngineClient,
    query: ApiQuery<"/v1/identity/invites", "get"> = {},
  ): Promise<Schemas["UserInviteListResponse"]> {
    const { data } = await this.api.GET("/v1/identity/invites", { params: { query } });
    return data as Schemas["UserInviteListResponse"];
  },
  async revokeInvite(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/identity/invites/{id}", { params: { path: { id } } });
  },
  async redeemInvite(
    this: EngineClient,
    body: Schemas["RedeemInviteBody"],
  ): Promise<InviteRedeemedWire> {
    const { data } = await this.api.POST("/v1/identity/invites/redeem", { body });
    return data as InviteRedeemedWire;
  },

  async listSystemAccounts(this: EngineClient): Promise<Schemas["SystemAccountListResponse"]> {
    const { data } = await this.api.GET("/v1/identity/system-accounts");
    return data as Schemas["SystemAccountListResponse"];
  },
  async createSystemAccount(
    this: EngineClient,
    body: Schemas["CreateSystemAccountBody"],
  ): Promise<Schemas["SystemAccount"]> {
    const { data } = await this.api.POST("/v1/identity/system-accounts", { body });
    return data as Schemas["SystemAccount"];
  },
  async deleteSystemAccount(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/identity/system-accounts/{id}", { params: { path: { id } } });
  },

  async listIdentityTenants(this: EngineClient): Promise<Schemas["TenantListResponse"]> {
    const { data } = await this.api.GET("/v1/identity/tenants");
    return data as Schemas["TenantListResponse"];
  },
  async getIdentityTenant(this: EngineClient, id: string): Promise<Schemas["Tenant"]> {
    const { data } = await this.api.GET("/v1/identity/tenants/{id}", { params: { path: { id } } });
    return data as Schemas["Tenant"];
  },
};
