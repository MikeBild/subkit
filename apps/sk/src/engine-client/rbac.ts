// RBAC + policy surfaces of the engine client: permission probes,
// effective-permission introspection, roles, grants, groups, and
// before-request hooks. Method group merged into `EngineClient` by
// `../engine-client.ts`.

import type { EngineClient } from "../engine-client.ts";

export const rbacMethods = {
  // --------------------------- RBAC probe ---------------------------
  /**
   * Probe whether the caller (or a specified principal id) holds a
   * permission. Used by the persona resolver + slash-command filter.
   */
  rbacCan(
    this: EngineClient,
    body: {
      principal_id: string;
      permission: string;
      resource?: { type: string; id: string };
    },
  ): Promise<{ allow: boolean; source: string | null; reason: string | null }> {
    return this.request("POST", "/v1/rbac/can", body);
  },

  // -------------------- RBAC Management --------------------
  listPermissions(this: EngineClient): Promise<{ items: string[] }> {
    return this.request("GET", "/v1/rbac/permissions");
  },
  /** The caller's own effective access level on a resource (currently
   *  connectors). Self-introspection — no permission required. */
  getEffectivePermissions(
    this: EngineClient,
    resource_type: string,
    resource_id: string,
  ): Promise<{
    resource_type: string;
    resource_id: string;
    level: "none" | "read-only" | "read-write";
    credential_scopes: unknown;
  }> {
    return this.request("GET", "/v1/identity/permissions", undefined, {
      resource_type,
      resource_id,
    });
  },
  listRoles(
    this: EngineClient,
    query: Record<string, string | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/rbac/roles", undefined, query);
  },
  getRole(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/rbac/roles/${encodeURIComponent(id)}`);
  },
  createRole(this: EngineClient, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/rbac/roles", body);
  },
  patchRole(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/rbac/roles/${encodeURIComponent(id)}`, body);
  },
  deleteRole(this: EngineClient, id: string): Promise<void> {
    return this.request("DELETE", `/v1/rbac/roles/${encodeURIComponent(id)}`);
  },
  grantRolePermission(
    this: EngineClient,
    roleId: string,
    permission: string,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/rbac/roles/${encodeURIComponent(roleId)}/permissions`, {
      permission,
    });
  },
  revokeRolePermission(this: EngineClient, roleId: string, permission: string): Promise<void> {
    return this.request(
      "DELETE",
      `/v1/rbac/roles/${encodeURIComponent(roleId)}/permissions/${encodeURIComponent(permission)}`,
    );
  },
  assignUserRole(
    this: EngineClient,
    userId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/rbac/users/${encodeURIComponent(userId)}/role`, body);
  },
  listGrants(
    this: EngineClient,
    query: Record<string, string | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/rbac/grants", undefined, query);
  },
  createGrant(this: EngineClient, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/rbac/grants", body);
  },
  deleteGrant(this: EngineClient, id: string): Promise<void> {
    return this.request("DELETE", `/v1/rbac/grants/${encodeURIComponent(id)}`);
  },
  listGroups(this: EngineClient): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/rbac/groups");
  },
  createGroup(this: EngineClient, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/rbac/groups", body);
  },
  patchGroup(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/rbac/groups/${encodeURIComponent(id)}`, body);
  },
  deleteGroup(this: EngineClient, id: string): Promise<void> {
    return this.request("DELETE", `/v1/rbac/groups/${encodeURIComponent(id)}`);
  },
  addGroupMember(this: EngineClient, groupId: string, userId: string): Promise<void> {
    return this.request(
      "POST",
      `/v1/rbac/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
    );
  },
  removeGroupMember(this: EngineClient, groupId: string, userId: string): Promise<void> {
    return this.request(
      "DELETE",
      `/v1/rbac/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
    );
  },
  assignGroupRole(this: EngineClient, groupId: string, roleId: string): Promise<void> {
    return this.request(
      "POST",
      `/v1/rbac/groups/${encodeURIComponent(groupId)}/roles/${encodeURIComponent(roleId)}`,
    );
  },
  removeGroupRole(this: EngineClient, groupId: string, roleId: string): Promise<void> {
    return this.request(
      "DELETE",
      `/v1/rbac/groups/${encodeURIComponent(groupId)}/roles/${encodeURIComponent(roleId)}`,
    );
  },

  // -------------------- Request Hooks --------------------
  listRequestHooks(this: EngineClient): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/auth/request-hooks");
  },
  createRequestHook(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/auth/request-hooks", body);
  },
  patchRequestHook(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/auth/request-hooks/${encodeURIComponent(id)}`, body);
  },
  deleteRequestHook(this: EngineClient, id: string): Promise<void> {
    return this.request("DELETE", `/v1/auth/request-hooks/${encodeURIComponent(id)}`);
  },
};
