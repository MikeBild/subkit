import * as prompts from "@clack/prompts";
import { exitCodeFor } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

function makeClient() {
  const profile = resolveProfile();
  return new EngineClient({
    engine_url: profile.engine_url,
    api_key: profile.api_key,
    tenant: profile.active_tenant_id,
  });
}

// ---------- permissions ----------

const permissionsListCmd = defineCommand({
  meta: { name: "list", description: "List the static permission catalog" },
  args: { json: { type: "boolean", description: "JSON output" } },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listPermissions();
      if (args.json) {
        printJson(items);
        return;
      }
      for (const p of items) process.stdout.write(`${p}\n`);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const permissionsCmd = defineCommand({
  meta: { name: "permissions", description: "Browse the permission catalog" },
  subCommands: { list: permissionsListCmd },
});

// ---------- roles ----------

const rolesListCmd = defineCommand({
  meta: { name: "list", description: "List roles" },
  args: { json: { type: "boolean", description: "JSON output" } },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listRoles();
      emitList(
        !!args.json,
        ["id", "name", "description", "created_at"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const rolesGetCmd = defineCommand({
  meta: { name: "get", description: "Fetch a role and its permissions" },
  args: { id: { type: "positional", required: true, description: "Role id" } },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.getRole(String(args.id)));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
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
    try {
      printJson(
        await client.createRole({ name: String(args.name), description: args.description }),
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const rolesDeleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a custom role" },
  args: { id: { type: "positional", required: true, description: "Role id" } },
  async run({ args }) {
    const client = makeClient();
    try {
      if (process.stdin.isTTY) {
        const confirmed = await prompts.confirm({ message: `Delete role "${args.id}"?` });
        if (!confirmed || prompts.isCancel(confirmed)) return;
      }
      await client.deleteRole(String(args.id));
      process.stdout.write("deleted\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
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
    try {
      printJson(await client.grantRolePermission(String(args.id), String(args.permission)));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
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
    try {
      await client.revokeRolePermission(String(args.id), String(args.permission));
      process.stdout.write("revoked\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
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
    id: { type: "positional", required: true, description: "User id" },
    role: { type: "positional", required: true, description: "Role id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.assignUserRole(String(args.id), { role_id: String(args.role) }));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const usersCmd = defineCommand({
  meta: { name: "users", description: "Manage user role bindings" },
  subCommands: { assign: usersAssignCmd },
});

// ---------- grants ----------

const grantsListCmd = defineCommand({
  meta: { name: "list", description: "List resource grants" },
  args: { json: { type: "boolean", description: "JSON output" } },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listGrants();
      emitList(
        !!args.json,
        ["id", "principal_id", "permission", "created_at"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
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
    try {
      const [subject_type, subject_id] = String(args.subject).split(":");
      const [resource_type, resource_id] = String(args.resource).split(":");
      if (!subject_type || !subject_id || !resource_type || !resource_id) {
        throw new Error("--subject / --resource must be <type>:<id>");
      }
      printJson(
        await client.createGrant({
          subject_type,
          subject_id,
          resource_type,
          resource_id,
          permission: String(args.permission),
        }),
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const grantsDeleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a resource grant" },
  args: { id: { type: "positional", required: true, description: "Grant id" } },
  async run({ args }) {
    const client = makeClient();
    try {
      const confirmed = await prompts.confirm({ message: `Delete grant "${args.id}"?` });
      if (!confirmed || prompts.isCancel(confirmed)) return;
      await client.deleteGrant(String(args.id));
      process.stdout.write("deleted\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const grantsCmd = defineCommand({
  meta: { name: "grants", description: "Manage resource grants" },
  subCommands: { list: grantsListCmd, create: grantsCreateCmd, delete: grantsDeleteCmd },
});

// ---------- groups ----------

const groupsListCmd = defineCommand({
  meta: { name: "list", description: "List groups" },
  args: { json: { type: "boolean", description: "JSON output" } },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listGroups();
      emitList(
        !!args.json,
        ["id", "name", "member_count", "created_at"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
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
    try {
      printJson(
        await client.createGroup({ name: String(args.name), description: args.description }),
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const groupsDeleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a group" },
  args: { id: { type: "positional", required: true, description: "Group id" } },
  async run({ args }) {
    const client = makeClient();
    try {
      const confirmed = await prompts.confirm({ message: `Delete group "${args.id}"?` });
      if (!confirmed || prompts.isCancel(confirmed)) return;
      await client.deleteGroup(String(args.id));
      process.stdout.write("deleted\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
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
    try {
      await client.addGroupMember(String(args.id), String(args.user));
      process.stdout.write("added\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
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
    try {
      await client.removeGroupMember(String(args.id), String(args.user));
      process.stdout.write("removed\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
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
    try {
      await client.assignGroupRole(String(args.id), String(args.role));
      process.stdout.write("assigned\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
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

// ---------- request-hooks ----------

const requestHooksListCmd = defineCommand({
  meta: { name: "list", description: "List request hooks" },
  args: { json: { type: "boolean", description: "JSON output" } },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listRequestHooks();
      emitList(
        !!args.json,
        ["id", "event_type", "url", "active"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const requestHooksCreateCmd = defineCommand({
  meta: { name: "create", description: "Create a request hook" },
  args: {
    url: { type: "string", required: true, description: "Webhook URL" },
    event: { type: "string", required: true, description: "Event type" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(
        await client.createRequestHook({ url: String(args.url), event_type: String(args.event) }),
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const requestHooksDeleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a request hook" },
  args: { id: { type: "positional", required: true, description: "Hook id" } },
  async run({ args }) {
    const client = makeClient();
    try {
      const confirmed = await prompts.confirm({ message: `Delete request hook "${args.id}"?` });
      if (!confirmed || prompts.isCancel(confirmed)) return;
      await client.deleteRequestHook(String(args.id));
      process.stdout.write("deleted\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
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

// ---------- can ----------

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
    try {
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
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

// ---------- root ----------

export const rbacCommand = defineCommand({
  meta: { name: "rbac", description: "Manage RBAC roles, permissions, grants, groups, and hooks" },
  subCommands: {
    permissions: permissionsCmd,
    roles: rolesCmd,
    users: usersCmd,
    grants: grantsCmd,
    groups: groupsCmd,
    "request-hooks": requestHooksCmd,
    can: canCmd,
  },
});
