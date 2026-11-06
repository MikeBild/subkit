import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";
import type { ApiBody, ApiQuery } from "./http.ts";

export type PermissionCatalogEntry = components["schemas"]["PermissionCatalogEntry"];
export type PermissionListResponse = components["schemas"]["RbacPermissionListResponse"];

export const rbacMethods = {
  async rbacCan(
    this: EngineClient,
    body: {
      principal_id: string;
      permission: string;
      resource?: { type: string; id: string };
    },
  ): Promise<{ allow: boolean; source: string | null; reason: string | null }> {
    const { data } = await this.api.POST("/v1/rbac/can", {
      body: body as ApiBody<"/v1/rbac/can", "post">,
    });
    return data as { allow: boolean; source: string | null; reason: string | null };
  },

  async listPermissions(this: EngineClient): Promise<PermissionListResponse> {
    const { data } = await this.api.GET("/v1/rbac/permissions");
    return data as PermissionListResponse;
  },
  async getEffectivePermissions(
    this: EngineClient,
    resource_type: string,
    resource_id: string,
  ): Promise<{
    resource_type: string;
    resource_id: string;
    level: "none" | "read-only" | "read-write";
    credential_scopes: unknown;
  }> {
    const { data } = await this.api.GET("/v1/identity/permissions", {
      params: {
        query: {
          resource_type,
          resource_id,
        } as ApiQuery<"/v1/identity/permissions", "get">,
      },
    });
    return data as {
      resource_type: string;
      resource_id: string;
      level: "none" | "read-only" | "read-write";
      credential_scopes: unknown;
    };
  },
  listRoles(
    this: EngineClient,
    query: Record<string, string | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/rbac/roles", undefined, query);
  },
  async getRole(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    const { data } = await this.api.GET("/v1/rbac/roles/{id}", { params: { path: { id } } });
    return data as Record<string, unknown>;
  },
  async createRole(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/rbac/roles", {
      body: body as ApiBody<"/v1/rbac/roles", "post">,
    });
    return data as Record<string, unknown>;
  },
  async patchRole(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.PATCH("/v1/rbac/roles/{id}", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/rbac/roles/{id}", "patch">,
    });
    return data as Record<string, unknown>;
  },
  async deleteRole(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/rbac/roles/{id}", { params: { path: { id } } });
  },
  async grantRolePermission(
    this: EngineClient,
    roleId: string,
    permission: string,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/rbac/roles/{id}/permissions", {
      params: { path: { id: roleId } },
      body: {
        permission,
      } as ApiBody<"/v1/rbac/roles/{id}/permissions", "post">,
    });
    return data as Record<string, unknown>;
  },
  async revokeRolePermission(
    this: EngineClient,
    roleId: string,
    permission: string,
  ): Promise<void> {
    await this.api.DELETE("/v1/rbac/roles/{id}/permissions/{permission}", {
      params: { path: { id: roleId, permission } },
    });
  },
  async assignUserRole(
    this: EngineClient,
    userId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/rbac/users/{user_id}/role", {
      params: { path: { user_id: userId } },
      body: body as ApiBody<"/v1/rbac/users/{user_id}/role", "post">,
    });
    return data as Record<string, unknown>;
  },
  listGrants(
    this: EngineClient,
    query: Record<string, string | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/rbac/grants", undefined, query);
  },
  async createGrant(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/rbac/grants", {
      body: body as ApiBody<"/v1/rbac/grants", "post">,
    });
    return data as Record<string, unknown>;
  },
  async deleteGrant(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/rbac/grants/{id}", { params: { path: { id } } });
  },
  async listGroups(this: EngineClient): Promise<{ items: Record<string, unknown>[] }> {
    const { data } = await this.api.GET("/v1/rbac/groups");
    return data as { items: Record<string, unknown>[] };
  },
  async createGroup(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/rbac/groups", {
      body: body as ApiBody<"/v1/rbac/groups", "post">,
    });
    return data as Record<string, unknown>;
  },
  async patchGroup(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.PATCH("/v1/rbac/groups/{id}", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/rbac/groups/{id}", "patch">,
    });
    return data as Record<string, unknown>;
  },
  async deleteGroup(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/rbac/groups/{id}", { params: { path: { id } } });
  },
  async addGroupMember(this: EngineClient, groupId: string, userId: string): Promise<void> {
    await this.api.POST("/v1/rbac/groups/{id}/members/{user_id}", {
      params: { path: { id: groupId, user_id: userId } },
    });
  },
  async removeGroupMember(this: EngineClient, groupId: string, userId: string): Promise<void> {
    await this.api.DELETE("/v1/rbac/groups/{id}/members/{user_id}", {
      params: { path: { id: groupId, user_id: userId } },
    });
  },
  async assignGroupRole(this: EngineClient, groupId: string, roleId: string): Promise<void> {
    await this.api.POST("/v1/rbac/groups/{id}/roles/{role_id}", {
      params: { path: { id: groupId, role_id: roleId } },
    });
  },
  async removeGroupRole(this: EngineClient, groupId: string, roleId: string): Promise<void> {
    await this.api.DELETE("/v1/rbac/groups/{id}/roles/{role_id}", {
      params: { path: { id: groupId, role_id: roleId } },
    });
  },

  async listRequestHooks(this: EngineClient): Promise<{ items: Record<string, unknown>[] }> {
    const { data } = await this.api.GET("/v1/auth/request-hooks");
    return data as { items: Record<string, unknown>[] };
  },
  async createRequestHook(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/auth/request-hooks", {
      body: body as ApiBody<"/v1/auth/request-hooks", "post">,
    });
    return data as Record<string, unknown>;
  },
  async patchRequestHook(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.PATCH("/v1/auth/request-hooks/{id}", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/auth/request-hooks/{id}", "patch">,
    });
    return data as Record<string, unknown>;
  },
  async deleteRequestHook(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/auth/request-hooks/{id}", { params: { path: { id } } });
  },
};
