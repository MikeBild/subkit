import { reportCommandError } from "@cli-core/errors";
import { emitList } from "@cli-core/format";
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

const listCommand = defineCommand({
  meta: { name: "list", description: "List credentials for a connector" },
  args: {
    "connector-id": { type: "positional", required: true, description: "Connector id" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const connector = (await client.getConnector(args["connector-id"])) as Record<
        string,
        unknown
      >;
      const credentials = (connector.credentials ?? []) as Record<string, unknown>[];
      emitList(
        !!args.json,
        ["id", "mode", "environment", "has_oauth_refresh", "created_at"],
        credentials,
      );
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

/** Parse "k=v,k2=v2" (or "k: v") pairs into a record for header/query modes. */
function parsePairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const sep = trimmed.includes("=") ? "=" : ":";
    const idx = trimmed.indexOf(sep);
    if (idx <= 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

const setCommand = defineCommand({
  meta: {
    name: "set",
    description:
      "Attach a credential to a connector (scriptable; no conversation needed). Modes: bearer | header | query | basic | aws_sigv4 | none.",
  },
  args: {
    "connector-id": { type: "positional", required: true, description: "Connector id" },
    mode: {
      type: "string",
      required: true,
      description: "bearer | header | query | basic | aws_sigv4 | none",
    },
    token: { type: "string", description: "Secret token (bearer mode)" },
    header: { type: "string", description: 'header mode: "Name=Value" (comma-separate multiple)' },
    query: { type: "string", description: 'query mode: "key=Value" (comma-separate multiple)' },
    username: { type: "string", description: "basic mode username" },
    password: { type: "string", description: "basic mode password" },
    "access-key-id": { type: "string", description: "aws_sigv4 access key id" },
    "secret-access-key": { type: "string", description: "aws_sigv4 secret access key" },
    "session-token": { type: "string", description: "aws_sigv4 optional STS session token" },
    "skip-checks": { type: "boolean", description: "Skip the post-set connectivity probe" },
    json: { type: "boolean", description: "JSON-only output" },
  },
  async run({ args }) {
    const client = makeClient();
    const jsonMode = Boolean(args.json);
    const connectorId = String(args["connector-id"]);
    const mode = String(args.mode).replace(/-/g, "_");
    const body: Record<string, unknown> = { mode };
    try {
      if (mode === "bearer") {
        if (!args.token) throw new Error("bearer mode requires --token");
        body.token = args.token;
      } else if (mode === "header") {
        if (!args.header) throw new Error('header mode requires --header "Name=Value"');
        body.headers = parsePairs(String(args.header));
      } else if (mode === "query") {
        if (!args.query) throw new Error('query mode requires --query "key=Value"');
        body.query = parsePairs(String(args.query));
      } else if (mode === "basic") {
        if (!args.username || !args.password)
          throw new Error("basic mode requires --username and --password");
        body.username = args.username;
        body.password = args.password;
      } else if (mode === "aws_sigv4") {
        if (!args["access-key-id"] || !args["secret-access-key"])
          throw new Error("aws_sigv4 mode requires --access-key-id and --secret-access-key");
        body.access_key_id = args["access-key-id"];
        body.secret_access_key = args["secret-access-key"];
        if (args["session-token"]) body.session_token = args["session-token"];
      } else if (mode !== "none") {
        throw new Error(`unknown --mode '${mode}' (bearer|header|query|basic|aws_sigv4|none)`);
      }

      const created = (await client.createCredential(connectorId, body)) as { id?: string };
      if (jsonMode) {
        process.stdout.write(`${JSON.stringify(created)}\n`);
        return;
      }
      process.stdout.write(`✓ credential attached to ${connectorId}\n`);

      if (!args["skip-checks"]) {
        try {
          const probe = (await client.testConnector(connectorId)) as { ok?: boolean };
          process.stdout.write(probe.ok ? "✓ probe ok\n" : "⚠ probe did not succeed\n");
        } catch {
          process.stdout.write("⚠ probe could not run\n");
        }
      }
    } catch (err) {
      reportCommandError(err, { json: jsonMode });
    }
  },
});

const rotateCommand = defineCommand({
  meta: { name: "rotate", description: "Rotate a credential" },
  args: {
    "credential-id": { type: "positional", required: true, description: "Credential id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      await client.rotateCredential(args["credential-id"]);
      process.stdout.write("rotated\n");
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a credential" },
  args: {
    "credential-id": { type: "positional", required: true, description: "Credential id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      await client.deleteCredential(args["credential-id"]);
      process.stdout.write("deleted\n");
    } catch (err) {
      reportCommandError(err);
    }
  },
});

export const credentialsCommand = defineCommand({
  meta: { name: "credentials", description: "Manage connector credentials" },
  subCommands: {
    list: listCommand,
    set: setCommand,
    rotate: rotateCommand,
    delete: deleteCommand,
  },
});
