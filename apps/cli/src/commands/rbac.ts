// `subkit rbac ...`
//
// Pass-2 C8: thin CLI wrapper around /v1/rbac/* endpoints so
// operators can manage permissions, roles, grants, groups, and run
// `can` queries without touching curl.

import { defineCommand } from "citty";
import { clientArgs, makeClient } from "../utils/client-args.ts";
import { emitList, emitOne } from "../utils/format.ts";

type ListResponse<T> = { items: T[] };

// ---------- permissions ----------

const permissionsListCmd = defineCommand({
  meta: { name: "list", description: "List the static permission catalog" },
  args: clientArgs,
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = await client.request<ListResponse<Record<string, unknown>>>(
      "GET",
      "/v1/rbac/permissions",
    );
    emitList(asJson, ["name", "resource_type", "description"], body.items);
  },
});

const permissionsCmd = defineCommand({
  meta: { name: "permissions", description: "Browse the permission catalog" },
  subCommands: { list: permissionsListCmd },
});

// ---------- roles ----------

const rolesListCmd = defineCommand({
  meta: { name: "list", description: "List roles (built-in + tenant-scoped)" },
  args: clientArgs,
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = await client.request<ListResponse<Record<string, unknown>>>(
      "GET",
      "/v1/rbac/roles",
    );
    emitList(asJson, ["id", "name", "is_builtin", "tenant_id", "description"], body.items);
  },
});

const rolesGetCmd = defineCommand({
  meta: { name: "get", description: "Fetch a role and its permissions" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Role id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const row = await client.request<Record<string, unknown>>("GET", `/v1/rbac/roles/${args.id}`);
    emitOne(asJson, row);
  },
});

const rolesCreateCmd = defineCommand({
  meta: { name: "create", description: "Create a custom tenant-scoped role" },
  args: {
    ...clientArgs,
    name: { type: "positional", description: "Role name", required: true },
    description: { type: "string", description: "Role description" },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const row = await client.request<Record<string, unknown>>("POST", "/v1/rbac/roles", {
      name: args.name,
      description: args.description,
    });
    emitOne(asJson, row);
  },
});

const rolesDeleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a custom role" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Role id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    await client.request("DELETE", `/v1/rbac/roles/${args.id}`);
    emitOne(asJson, { ok: true });
  },
});

const rolesGrantCmd = defineCommand({
  meta: { name: "grant", description: "Grant a permission to a role" },
  args: {
    ...clientArgs,
    role: { type: "positional", description: "Role id", required: true },
    permission: { type: "positional", description: "Permission name", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const row = await client.request<Record<string, unknown>>(
      "POST",
      `/v1/rbac/roles/${args.role}/permissions`,
      { permission: args.permission },
    );
    emitOne(asJson, row);
  },
});

const rolesRevokeCmd = defineCommand({
  meta: { name: "revoke", description: "Revoke a permission from a role" },
  args: {
    ...clientArgs,
    role: { type: "positional", description: "Role id", required: true },
    permission: { type: "positional", description: "Permission name", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    await client.request("DELETE", `/v1/rbac/roles/${args.role}/permissions/${args.permission}`);
    emitOne(asJson, { ok: true });
  },
});

const rolesCmd = defineCommand({
  meta: { name: "roles", description: "Manage RBAC roles" },
  subCommands: {
    list: rolesListCmd,
    get: rolesGetCmd,
    create: rolesCreateCmd,
    delete: rolesDeleteCmd,
    grant: rolesGrantCmd,
    revoke: rolesRevokeCmd,
  },
});

// ---------- users ----------

const usersAssignCmd = defineCommand({
  meta: { name: "assign", description: "Assign a role to a user" },
  args: {
    ...clientArgs,
    user: { type: "positional", description: "User id", required: true },
    role: { type: "positional", description: "Role id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const row = await client.request<Record<string, unknown>>(
      "POST",
      `/v1/rbac/users/${args.user}/role`,
      { role_id: args.role },
    );
    emitOne(asJson, row);
  },
});

const usersCmd = defineCommand({
  meta: { name: "users", description: "Manage user role bindings" },
  subCommands: { assign: usersAssignCmd },
});

// ---------- grants ----------

const grantsListCmd = defineCommand({
  meta: { name: "list", description: "List resource grants" },
  args: clientArgs,
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = await client.request<ListResponse<Record<string, unknown>>>(
      "GET",
      "/v1/rbac/grants",
    );
    emitList(
      asJson,
      ["id", "subject_type", "subject_id", "resource_type", "resource_id", "permission"],
      body.items,
    );
  },
});

const grantsCreateCmd = defineCommand({
  meta: { name: "create", description: "Create a resource grant" },
  args: {
    ...clientArgs,
    subject: { type: "string", description: "subject in <type>:<id> form", required: true },
    resource: { type: "string", description: "resource in <type>:<id> form", required: true },
    permission: { type: "string", description: "permission name", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const [subject_type, subject_id] = (args.subject as string).split(":");
    const [resource_type, resource_id] = (args.resource as string).split(":");
    if (!subject_type || !subject_id || !resource_type || !resource_id) {
      throw new Error("--subject / --resource must be <type>:<id>");
    }
    const row = await client.request<Record<string, unknown>>("POST", "/v1/rbac/grants", {
      subject_type,
      subject_id,
      resource_type,
      resource_id,
      permission: args.permission,
    });
    emitOne(asJson, row);
  },
});

const grantsDeleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a resource grant" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Grant id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    await client.request("DELETE", `/v1/rbac/grants/${args.id}`);
    emitOne(asJson, { ok: true });
  },
});

const grantsCmd = defineCommand({
  meta: { name: "grants", description: "Manage resource grants" },
  subCommands: {
    list: grantsListCmd,
    create: grantsCreateCmd,
    delete: grantsDeleteCmd,
  },
});

// ---------- groups ----------

const groupsListCmd = defineCommand({
  meta: { name: "list", description: "List groups" },
  args: clientArgs,
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = await client.request<ListResponse<Record<string, unknown>>>(
      "GET",
      "/v1/rbac/groups",
    );
    emitList(asJson, ["id", "name", "description"], body.items);
  },
});

const groupsCreateCmd = defineCommand({
  meta: { name: "create", description: "Create a group" },
  args: {
    ...clientArgs,
    name: { type: "positional", description: "Group name", required: true },
    description: { type: "string", description: "Group description" },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const row = await client.request<Record<string, unknown>>("POST", "/v1/rbac/groups", {
      name: args.name,
      description: args.description,
    });
    emitOne(asJson, row);
  },
});

const groupsDeleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a group" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Group id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    await client.request("DELETE", `/v1/rbac/groups/${args.id}`);
    emitOne(asJson, { ok: true });
  },
});

const groupsAddMemberCmd = defineCommand({
  meta: { name: "add-member", description: "Add a user to a group" },
  args: {
    ...clientArgs,
    group: { type: "positional", description: "Group id", required: true },
    user: { type: "positional", description: "User id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const row = await client.request<Record<string, unknown>>(
      "POST",
      `/v1/rbac/groups/${args.group}/members/${args.user}`,
    );
    emitOne(asJson, row);
  },
});

const groupsAssignRoleCmd = defineCommand({
  meta: { name: "assign-role", description: "Assign a role to a group" },
  args: {
    ...clientArgs,
    group: { type: "positional", description: "Group id", required: true },
    role: { type: "positional", description: "Role id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const row = await client.request<Record<string, unknown>>(
      "POST",
      `/v1/rbac/groups/${args.group}/roles/${args.role}`,
    );
    emitOne(asJson, row);
  },
});

const groupsCmd = defineCommand({
  meta: { name: "groups", description: "Manage groups" },
  subCommands: {
    list: groupsListCmd,
    create: groupsCreateCmd,
    delete: groupsDeleteCmd,
    "add-member": groupsAddMemberCmd,
    "assign-role": groupsAssignRoleCmd,
  },
});

// ---------- can query ----------

const canCmd = defineCommand({
  meta: { name: "can", description: "Query the RBAC evaluator" },
  args: {
    ...clientArgs,
    principal: {
      type: "positional",
      description: "Principal id (user or system_account)",
      required: true,
    },
    permission: { type: "positional", description: "Permission name", required: true },
    resource: { type: "string", description: "Optional resource in <type>:<id> form" },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body: Record<string, unknown> = {
      principal_id: args.principal,
      permission: args.permission,
    };
    if (typeof args.resource === "string" && args.resource) {
      const [type, id] = (args.resource as string).split(":");
      if (type && id) body.resource = { type, id };
    }
    const row = await client.request<Record<string, unknown>>("POST", "/v1/rbac/can", body);
    emitOne(asJson, row);
  },
});

// ---------- root ----------

export const rbacCommand = defineCommand({
  meta: { name: "rbac", description: "Manage RBAC roles, permissions, grants, groups" },
  subCommands: {
    permissions: permissionsCmd,
    roles: rolesCmd,
    users: usersCmd,
    grants: grantsCmd,
    groups: groupsCmd,
    can: canCmd,
  },
});
