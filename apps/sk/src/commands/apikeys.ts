import { reportCommandError } from "@cli-core/errors";
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

const listCmd = defineCommand({
  meta: { name: "list", description: "List API keys" },
  args: { json: { type: "boolean", description: "JSON output" } },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listApiKeys();
      emitList(
        !!args.json,
        ["id", "name", "prefix", "created_at", "expires_at"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

function csv(value: unknown): string[] | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

const createCmd = defineCommand({
  meta: { name: "create", description: "Issue a new API key (shown once)" },
  args: {
    // Friendly label. Optional; can also be passed positionally for back-compat
    // with the previous `sk apikeys create <name>` invocation shape.
    name: { type: "string", description: "Friendly key name (label)" },
    expires: { type: "string", description: "Expiry — ISO-8601 timestamp" },
    scopes: {
      type: "string",
      description:
        'Comma-separated scope strings (e.g. "workflow:read,workflow:invoke"). Defaults to ["*"] — full role-derived access, and read-and-execute over MCP. Add "mcp:authoring" for a key that may also author definitions over MCP (a coding agent); leave it off for a key going into a browser client.',
    },
    "allowed-workflows": {
      type: "string",
      description: 'Comma-separated workflow ids/slugs. Use "*" for explicit "all".',
    },
    "allowed-connectors": {
      type: "string",
      description: 'Comma-separated connector ids/slugs. Use "*" for explicit "all".',
    },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      // Resolve the calling actor's identity so the route receives the
      // mandatory {owner_kind, owner_id} pair without the user having to
      // supply them. Admins who need to mint a key for someone else
      // should use the HTTP API directly today.
      const me = (await client.whoami()) as {
        id: string;
        kind: "user" | "system_account";
      };
      const body: Record<string, unknown> = {
        owner_kind: me.kind,
        owner_id: me.id,
      };
      if (args.name) body.name = String(args.name);
      if (args.expires) body.expires_at = String(args.expires);
      const scopes = csv(args.scopes);
      if (scopes) body.scopes = scopes;
      const aw = csv(args["allowed-workflows"]);
      if (aw) body.allowed_workflows = aw;
      const ac = csv(args["allowed-connectors"]);
      if (ac) body.allowed_connectors = ac;
      const result = await client.issueApiKey(body);
      process.stderr.write("warning: the key value is shown only once — store it securely\n");
      printJson(result);
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const rotateCmd = defineCommand({
  meta: { name: "rotate", description: "Rotate an API key (new key shown once)" },
  args: { id: { type: "positional", required: true, description: "Key id" } },
  async run({ args }) {
    const client = makeClient();
    try {
      const result = await client.rotateApiKey(String(args.id));
      process.stderr.write("warning: the new key value is shown only once — store it securely\n");
      printJson(result);
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const revokeCmd = defineCommand({
  meta: { name: "revoke", description: "Revoke an API key" },
  args: { id: { type: "positional", required: true, description: "Key id" } },
  async run({ args }) {
    const client = makeClient();
    try {
      await client.revokeApiKey(String(args.id));
      process.stdout.write("revoked\n");
    } catch (err) {
      reportCommandError(err);
    }
  },
});

export const apiKeysCommand = defineCommand({
  meta: { name: "apikeys", description: "Manage API keys" },
  subCommands: { list: listCmd, create: createCmd, rotate: rotateCmd, revoke: revokeCmd },
});
