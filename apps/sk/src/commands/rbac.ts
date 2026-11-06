import { readFileSync } from "node:fs";
import * as prompts from "@clack/prompts";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { makeClient, withCommandErrors } from "./command-runtime.ts";

type Schemas = components["schemas"];

const GRANT_SUBJECT_TYPES: readonly Schemas["CreateRbacGrantRequest"]["subject_type"][] = [
  "user",
  "system_account",
  "group",
];

function grantSubjectType(value: string): Schemas["CreateRbacGrantRequest"]["subject_type"] {
  const match = GRANT_SUBJECT_TYPES.find((type) => type === value);
  if (!match) throw new Error("--subject type must be one of user|system_account|group");
  return match;
}

function nameAndDescription(
  name: string,
  description: string | undefined,
): { name: string; description?: string } {
  return description === undefined ? { name } : { name, description };
}

const permissionsListCmd = defineCommand({
  meta: { name: "list", description: "List the static permission catalog" },
  args: { json: { type: "boolean", description: "JSON output" } },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const { items } = await client.listPermissions();
        emitList(!!args.json, ["name", "resource_type", "operator", "description"], items);
      },
      { json: Boolean(args.json) },
    );
  },
});

const permissionsCmd = defineCommand({
  meta: { name: "permissions", description: "Browse the permission catalog" },
  subCommands: { list: permissionsListCmd },
});

const whatcanCmd = defineCommand({
  meta: {
    name: "whatcan",
    description: "Show your effective access level on a connector (none/read-only/read-write)",
  },
  args: {
    connector: { type: "positional", required: true, description: "Connector id" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const result = await client.getEffectivePermissions("connector", String(args.connector));
        if (args.json) {
          printJson(result);
          return;
        }
        process.stdout.write(`connector ${result.resource_id}: ${result.level}\n`);
      },
      { json: Boolean(args.json) },
    );
  },
});

const rolesListCmd = defineCommand({
  meta: { name: "list", description: "List roles" },
  args: { json: { type: "boolean", description: "JSON output" } },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const { items } = await client.listRoles();
        emitList(!!args.json, ["id", "name", "description", "created_at"], items);
      },
      { json: Boolean(args.json) },
    );
  },
});

const rolesGetCmd = defineCommand({
  meta: { name: "get", description: "Fetch a role and its permissions" },
  args: { id: { type: "positional", required: true, description: "Role id" } },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      printJson(await client.getRole(String(args.id)));
    });
  },
});

const rolesCreateCmd = defineCommand({
  meta: { name: "create", description: "Create a custom role" },
  args: {
    name: { type: "positional", required: true, description: "Role name" },
    description: { type: "string", description: "Role description" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      printJson(await client.createRole(nameAndDescription(String(args.name), args.description)));
    });
  },
});

const rolesDeleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a custom role" },
  args: {
    id: { type: "positional", required: true, description: "Role id" },
    yes: { type: "boolean", description: "Skip the interactive confirmation prompt" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      if (!args.yes && process.stdin.isTTY) {
        const confirmed = await prompts.confirm({ message: `Delete role "${args.id}"?` });
        if (!confirmed || prompts.isCancel(confirmed)) return;
      }
      await client.deleteRole(String(args.id));
      process.stdout.write("deleted\n");
    });
  },
});

const rolesGrantCmd = defineCommand({
  meta: { name: "grant", description: "Grant a permission to a role" },
  args: {
    id: { type: "positional", required: true, description: "Role id" },
    permission: { type: "positional", required: true, description: "Permission name" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      printJson(await client.grantRolePermission(String(args.id), String(args.permission)));
    });
  },
});

const rolesRevokeCmd = defineCommand({
  meta: { name: "revoke", description: "Revoke a permission from a role" },
  args: {
    id: { type: "positional", required: true, description: "Role id" },
    permission: { type: "positional", required: true, description: "Permission name" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      await client.revokeRolePermission(String(args.id), String(args.permission));
      process.stdout.write("revoked\n");
    });
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

const usersAssignCmd = defineCommand({
  meta: { name: "assign", description: "Assign a role to a user" },
  args: {
    id: { type: "positional", required: true, description: "User id" },
    role: { type: "positional", required: true, description: "Role id" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      printJson(await client.assignUserRole(String(args.id), { role_id: String(args.role) }));
    });
  },
});

const usersCmd = defineCommand({
  meta: { name: "users", description: "Manage user role bindings" },
  subCommands: { assign: usersAssignCmd },
});

const grantsListCmd = defineCommand({
  meta: { name: "list", description: "List resource grants" },
  args: { json: { type: "boolean", description: "JSON output" } },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const { items } = await client.listGrants();
        emitList(
          !!args.json,
          [
            "id",
            "subject_type",
            "subject_id",
            "resource_type",
            "resource_id",
            "permission",
            "created_at",
          ],
          items,
        );
      },
      { json: Boolean(args.json) },
    );
  },
});

const grantsCreateCmd = defineCommand({
  meta: { name: "create", description: "Create a resource grant" },
  args: {
    subject: { type: "string", required: true, description: "Subject in <type>:<id> form" },
    resource: { type: "string", required: true, description: "Resource in <type>:<id> form" },
    permission: { type: "string", required: true, description: "Permission name" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      const [subject_type, subject_id] = String(args.subject).split(":");
      const [resource_type, resource_id] = String(args.resource).split(":");
      if (!subject_type || !subject_id || !resource_type || !resource_id) {
        throw new Error("--subject / --resource must be <type>:<id>");
      }
      printJson(
        await client.createGrant({
          subject_type: grantSubjectType(subject_type),
          subject_id,
          resource_type,
          resource_id,
          permission: String(args.permission),
        }),
      );
    });
  },
});

const grantsDeleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a resource grant" },
  args: {
    id: { type: "positional", required: true, description: "Grant id" },
    yes: { type: "boolean", description: "Skip the interactive confirmation prompt" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      if (!args.yes && process.stdin.isTTY) {
        const confirmed = await prompts.confirm({ message: `Delete grant "${args.id}"?` });
        if (!confirmed || prompts.isCancel(confirmed)) return;
      }
      await client.deleteGrant(String(args.id));
      process.stdout.write("deleted\n");
    });
  },
});

const grantsCmd = defineCommand({
  meta: { name: "grants", description: "Manage resource grants" },
  subCommands: { list: grantsListCmd, create: grantsCreateCmd, delete: grantsDeleteCmd },
});

const groupsListCmd = defineCommand({
  meta: { name: "list", description: "List groups" },
  args: { json: { type: "boolean", description: "JSON output" } },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const { items } = await client.listGroups();
        emitList(!!args.json, ["id", "name", "member_count", "created_at"], items);
      },
      { json: Boolean(args.json) },
    );
  },
});

const groupsCreateCmd = defineCommand({
  meta: { name: "create", description: "Create a group" },
  args: {
    name: { type: "positional", required: true, description: "Group name" },
    description: { type: "string", description: "Group description" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      printJson(await client.createGroup(nameAndDescription(String(args.name), args.description)));
    });
  },
});

const groupsDeleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a group" },
  args: {
    id: { type: "positional", required: true, description: "Group id" },
    yes: { type: "boolean", description: "Skip the interactive confirmation prompt" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      if (!args.yes && process.stdin.isTTY) {
        const confirmed = await prompts.confirm({ message: `Delete group "${args.id}"?` });
        if (!confirmed || prompts.isCancel(confirmed)) return;
      }
      await client.deleteGroup(String(args.id));
      process.stdout.write("deleted\n");
    });
  },
});

const groupsAddMemberCmd = defineCommand({
  meta: { name: "add-member", description: "Add a user to a group" },
  args: {
    id: { type: "positional", required: true, description: "Group id" },
    user: { type: "positional", required: true, description: "User id" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      await client.addGroupMember(String(args.id), String(args.user));
      process.stdout.write("added\n");
    });
  },
});

const groupsRemoveMemberCmd = defineCommand({
  meta: { name: "remove-member", description: "Remove a user from a group" },
  args: {
    id: { type: "positional", required: true, description: "Group id" },
    user: { type: "string", required: true, description: "User id" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      await client.removeGroupMember(String(args.id), String(args.user));
      process.stdout.write("removed\n");
    });
  },
});

const groupsAssignRoleCmd = defineCommand({
  meta: { name: "assign-role", description: "Assign a role to a group" },
  args: {
    id: { type: "positional", required: true, description: "Group id" },
    role: { type: "positional", required: true, description: "Role id" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      await client.assignGroupRole(String(args.id), String(args.role));
      process.stdout.write("assigned\n");
    });
  },
});

const groupsCmd = defineCommand({
  meta: { name: "groups", description: "Manage groups" },
  subCommands: {
    list: groupsListCmd,
    create: groupsCreateCmd,
    delete: groupsDeleteCmd,
    "add-member": groupsAddMemberCmd,
    "remove-member": groupsRemoveMemberCmd,
    "assign-role": groupsAssignRoleCmd,
  },
});

const requestHooksListCmd = defineCommand({
  meta: { name: "list", description: "List request hooks" },
  args: { json: { type: "boolean", description: "JSON output" } },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const { items } = await client.listRequestHooks();
        emitList(!!args.json, ["id", "role", "version", "enabled", "description"], items);
      },
      { json: Boolean(args.json) },
    );
  },
});

const requestHooksCreateCmd = defineCommand({
  meta: { name: "create", description: "Create a request hook" },
  args: {
    role: { type: "string", required: true, description: "Role whose requests the hook runs on" },
    file: { type: "string", required: true, description: "Path to the hook source file" },
    description: { type: "string", description: "Hook description" },
    disabled: { type: "boolean", description: "Create the hook disabled" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      const body: Schemas["CreateRequestHookBody"] = {
        role: String(args.role),
        code: readFileSync(String(args.file), "utf8"),
      };
      if (args.description) body.description = String(args.description);
      if (args.disabled) body.enabled = false;
      printJson(await client.createRequestHook(body));
    });
  },
});

const requestHooksDeleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a request hook" },
  args: {
    id: { type: "positional", required: true, description: "Hook id" },
    yes: { type: "boolean", description: "Skip the interactive confirmation prompt" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      if (!args.yes && process.stdin.isTTY) {
        const confirmed = await prompts.confirm({ message: `Delete request hook "${args.id}"?` });
        if (!confirmed || prompts.isCancel(confirmed)) return;
      }
      await client.deleteRequestHook(String(args.id));
      process.stdout.write("deleted\n");
    });
  },
});

const requestHooksCmd = defineCommand({
  meta: { name: "request-hooks", description: "Manage before-request hooks" },
  subCommands: {
    list: requestHooksListCmd,
    create: requestHooksCreateCmd,
    delete: requestHooksDeleteCmd,
  },
});

const canCmd = defineCommand({
  meta: { name: "can", description: "Check whether a principal holds a permission" },
  args: {
    principal: { type: "positional", required: true, description: "Principal id" },
    permission: { type: "positional", required: true, description: "Permission name" },
    resource: {
      type: "positional",
      required: false,
      description: "Optional resource in <type>:<id> form",
    },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const canBody: Parameters<typeof client.rbacCan>[0] = {
          principal_id: String(args.principal),
          permission: String(args.permission),
        };
        if (args.resource) {
          const [rType, rId] = String(args.resource).split(":");
          if (rType && rId) canBody.resource = { type: rType, id: rId };
        }
        const result = await client.rbacCan(canBody);
        if (args.json) {
          process.stdout.write(`${JSON.stringify({ allow: result.allow })}\n`);
        } else {
          process.stdout.write(`${result.allow}\n`);
        }
      },
      { json: Boolean(args.json) },
    );
  },
});

export const rbacCommand = defineCommand({
  meta: { name: "rbac", description: "Manage RBAC roles, permissions, grants, groups, and hooks" },
  subCommands: {
    permissions: permissionsCmd,
    whatcan: whatcanCmd,
    roles: rolesCmd,
    users: usersCmd,
    grants: grantsCmd,
    groups: groupsCmd,
    "request-hooks": requestHooksCmd,
    can: canCmd,
  },
});
