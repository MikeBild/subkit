import * as prompts from "@clack/prompts";
import { reportCommandError } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";

import { resolveProfile } from "../config.ts";
import { EngineClient, type UserInviteIssuedWire } from "../engine-client.ts";

function makeClient() {
  const profile = resolveProfile();
  return new EngineClient({
    engine_url: profile.engine_url,
    api_key: profile.api_key,
    tenant: profile.active_tenant_id,
  });
}

/** Split a comma-separated flag into a trimmed, non-empty list. */
function csv(value: unknown): string[] | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/**
 * Render the once-only invite banner for `sk users invite`. Extracted
 * (and exported) so the printed shape — the plaintext token plus the
 * ready-to-paste `sk join` line and the expiry — is unit-testable
 * without standing up the citty/disk/HTTP layers.
 */
export function formatInviteIssued(invite: UserInviteIssuedWire): string {
  return (
    `invite issued for user ${invite.user_id}\n` +
    `  token    ${invite.plaintext_token}\n` +
    `  expires  ${invite.expires_at}\n` +
    `\n` +
    `the invited user runs:\n` +
    `  sk join --invite ${invite.plaintext_token}\n`
  );
}

const listCmd = defineCommand({
  meta: { name: "list", description: "List identity users" },
  args: {
    limit: { type: "string", description: "Max rows" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const q: Record<string, string | number | undefined> = {};
      if (args.limit) q.limit = Number(args.limit);
      const { items } = await client.listIdentityUsers(q);
      emitList(
        !!args.json,
        ["id", "email", "role", "status", "created_at"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const createCmd = defineCommand({
  meta: { name: "create", description: "Create a user in the caller's tenant" },
  args: {
    email: { type: "string", required: true, description: "User email" },
    role: { type: "string", description: "Role: admin|member|enduser (default member)" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const body: { email: string; role?: "admin" | "member" | "enduser" } = {
        email: String(args.email),
      };
      if (args.role) {
        const role = String(args.role);
        if (role !== "admin" && role !== "member" && role !== "enduser") {
          process.stderr.write("sk users create: --role must be one of admin|member|enduser\n");
          process.exit(2);
        }
        body.role = role;
      }
      const user = await client.createUser(body);
      if (args.json) {
        printJson(user);
        return;
      }
      process.stdout.write(
        `created user\n` +
          `  id     ${user.id}\n` +
          `  email  ${user.email}\n` +
          `  role   ${user.role}\n`,
      );
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const inviteCmd = defineCommand({
  meta: {
    name: "invite",
    description: "Issue a single-use provisioning invite for a user (token shown once)",
  },
  args: {
    id: { type: "positional", required: true, description: "User id to invite" },
    scopes: { type: "string", description: 'Comma-separated scope strings (default ["*"])' },
    "allowed-workflows": { type: "string", description: "Comma-separated workflow ids/slugs" },
    "allowed-connectors": { type: "string", description: "Comma-separated connector ids/slugs" },
    ttl: { type: "string", description: "Invite lifetime in minutes" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const body: {
        scopes?: string[];
        allowed_workflows?: string[];
        allowed_connectors?: string[];
        ttl_minutes?: number;
      } = {};
      const scopes = csv(args.scopes);
      if (scopes) body.scopes = scopes;
      const aw = csv(args["allowed-workflows"]);
      if (aw) body.allowed_workflows = aw;
      const ac = csv(args["allowed-connectors"]);
      if (ac) body.allowed_connectors = ac;
      if (args.ttl) {
        const ttl = Number(args.ttl);
        if (!Number.isInteger(ttl) || ttl <= 0) {
          process.stderr.write("sk users invite: --ttl must be a positive integer (minutes)\n");
          process.exit(2);
        }
        body.ttl_minutes = ttl;
      }
      const invite = await client.createInvite(String(args.id), body);
      if (args.json) {
        printJson(invite);
        return;
      }
      process.stderr.write(
        "warning: the invite token is shown only once — hand it to the invited user securely\n",
      );
      process.stdout.write(formatInviteIssued(invite));
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const getCmd = defineCommand({
  meta: { name: "get", description: "Fetch a user by id" },
  args: { id: { type: "positional", required: true, description: "User id" } },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.getIdentityUser(String(args.id)));
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const patchCmd = defineCommand({
  meta: { name: "patch", description: "Update a user's role (admin only)" },
  args: {
    id: { type: "positional", required: true, description: "User id" },
    role: {
      type: "string",
      required: true,
      description: "New role: admin|member|enduser",
    },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const role = String(args.role);
      if (role !== "admin" && role !== "member" && role !== "enduser") {
        process.stderr.write("sk users patch: --role must be one of admin|member|enduser\n");
        process.exit(2);
      }
      printJson(await client.patchIdentityUser(String(args.id), { role }));
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const deleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a user" },
  args: { id: { type: "positional", required: true, description: "User id" } },
  async run({ args }) {
    const client = makeClient();
    try {
      const confirmed = await prompts.confirm({ message: `Delete user "${args.id}"?` });
      if (!confirmed || prompts.isCancel(confirmed)) return;
      await client.deleteIdentityUser(String(args.id));
      process.stdout.write("deleted\n");
    } catch (err) {
      reportCommandError(err);
    }
  },
});

export const usersCommand = defineCommand({
  meta: { name: "users", description: "Manage identity users" },
  subCommands: {
    list: listCmd,
    get: getCmd,
    create: createCmd,
    invite: inviteCmd,
    patch: patchCmd,
    delete: deleteCmd,
  },
});
