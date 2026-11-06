import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";
import type { ApiQuery } from "./http.ts";

type Schemas = components["schemas"];

export type PermissionCatalogEntry = Schemas["PermissionCatalogEntry"];
export type PermissionListResponse = Schemas["RbacPermissionListResponse"];

export const rbacMethods = {
  async rbacCan(
    this: EngineClient,
    body: Schemas["RbacCanRequest"],
  ): Promise<Schemas["RbacCanResponse"]> {
    const { data } = await this.api.POST("/v1/rbac/can", { body });
    return data as Schemas["RbacCanResponse"];
  },

  async listPermissions(this: EngineClient): Promise<PermissionListResponse> {
    const { data } = await this.api.GET("/v1/rbac/permissions");
    return data as PermissionListResponse;
  },
  async getEffectivePermissions(
    this: EngineClient,
    resource_type: ApiQuery<"/v1/identity/permissions", "get">["resource_type"],
    resource_id: string,
  ): Promise<Schemas["EffectivePermissions"]> {
    const { data } = await this.api.GET("/v1/identity/permissions", {
      params: { query: { resource_type, resource_id } },
    });
    return data as Schemas["EffectivePermissions"];
  },
  async listRoles(this: EngineClient): Promise<Schemas["RbacRoleListResponse"]> {
    const { data } = await this.api.GET("/v1/rbac/roles");
    return data as Schemas["RbacRoleListResponse"];
  },
  async getRole(this: EngineClient, id: string): Promise<Schemas["RbacRoleDetail"]> {
    const { data } = await this.api.GET("/v1/rbac/roles/{id}", { params: { path: { id } } });
    return data as Schemas["RbacRoleDetail"];
  },
  async createRole(
    this: EngineClient,
    body: Schemas["CreateRbacRoleRequest"],
  ): Promise<Schemas["RbacRole"]> {
    const { data } = await this.api.POST("/v1/rbac/roles", { body });
    return data as Schemas["RbacRole"];
  },
  async patchRole(
    this: EngineClient,
    id: string,
    body: Schemas["UpdateRbacRoleRequest"],
  ): Promise<Schemas["RbacRole"]> {
    const { data } = await this.api.PATCH("/v1/rbac/roles/{id}", {
      params: { path: { id } },
      body,
    });
    return data as Schemas["RbacRole"];
  },
  async deleteRole(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/rbac/roles/{id}", { params: { path: { id } } });
  },
  async grantRolePermission(
    this: EngineClient,
    roleId: string,
    permission: string,
  ): Promise<{ ok: true }> {
    const { data } = await this.api.POST("/v1/rbac/roles/{id}/permissions", {
      params: { path: { id: roleId } },
      body: { permission },
    });
    return data as { ok: true };
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
    body: Schemas["AssignUserRoleRequest"],
  ): Promise<Schemas["AssignUserRoleResponse"]> {
    const { data } = await this.api.POST("/v1/rbac/users/{user_id}/role", {
      params: { path: { user_id: userId } },
      body,
    });
    return data as Schemas["AssignUserRoleResponse"];
  },
  async listGrants(this: EngineClient): Promise<Schemas["RbacGrantListResponse"]> {
    const { data } = await this.api.GET("/v1/rbac/grants");
    return data as Schemas["RbacGrantListResponse"];
  },
  async createGrant(
    this: EngineClient,
    body: Schemas["CreateRbacGrantRequest"],
  ): Promise<Schemas["RbacGrant"]> {
    const { data } = await this.api.POST("/v1/rbac/grants", { body });
    return data as Schemas["RbacGrant"];
  },
  async deleteGrant(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/rbac/grants/{id}", { params: { path: { id } } });
  },
  async listGroups(this: EngineClient): Promise<Schemas["RbacGroupListResponse"]> {
    const { data } = await this.api.GET("/v1/rbac/groups");
    return data as Schemas["RbacGroupListResponse"];
  },
  async createGroup(
    this: EngineClient,
    body: Schemas["CreateRbacGroupRequest"],
  ): Promise<Schemas["RbacGroup"]> {
    const { data } = await this.api.POST("/v1/rbac/groups", { body });
    return data as Schemas["RbacGroup"];
  },
  async patchGroup(
    this: EngineClient,
    id: string,
    body: Schemas["UpdateRbacGroupRequest"],
  ): Promise<Schemas["RbacGroup"]> {
    const { data } = await this.api.PATCH("/v1/rbac/groups/{id}", {
      params: { path: { id } },
      body,
    });
    return data as Schemas["RbacGroup"];
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

  async listRequestHooks(this: EngineClient): Promise<Schemas["RequestHookListResponse"]> {
    const { data } = await this.api.GET("/v1/auth/request-hooks");
    return data as Schemas["RequestHookListResponse"];
  },
  async createRequestHook(
    this: EngineClient,
    body: Schemas["CreateRequestHookBody"],
  ): Promise<Schemas["RequestHook"]> {
    const { data } = await this.api.POST("/v1/auth/request-hooks", { body });
    return data as Schemas["RequestHook"];
  },
  async patchRequestHook(
    this: EngineClient,
    id: string,
    body: Schemas["UpdateRequestHookBody"],
  ): Promise<Schemas["RequestHook"]> {
    const { data } = await this.api.PATCH("/v1/auth/request-hooks/{id}", {
      params: { path: { id } },
      body,
    });
    return data as Schemas["RequestHook"];
  },
  async deleteRequestHook(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/auth/request-hooks/{id}", { params: { path: { id } } });
  },
};
