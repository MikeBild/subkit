import { readFile } from "node:fs/promises";
import { emitList } from "@cli-core/format";
import { defineCommand } from "citty";
import type { CredentialBody } from "../engine-client/connectors.ts";
import { makeClient, withCommandErrors } from "./command-runtime.ts";

const listCommand = defineCommand({
  meta: { name: "list", description: "List credentials for a connector" },
  args: {
    "connector-id": { type: "positional", required: true, description: "Connector id" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const connector = await client.getConnector(args["connector-id"]);
        const credentials = connector.credentials ?? [];
        emitList(
          !!args.json,
          ["id", "mode", "environment", "has_oauth_refresh", "created_at"],
          credentials,
        );
      },
      { json: Boolean(args.json) },
    );
  },
});

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

export interface CredentialArgs {
  mode: string;
  token?: string | undefined;
  privateKey?: string | undefined;
  header?: string | undefined;
  query?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  sessionToken?: string | undefined;
}

export function credentialBody(args: CredentialArgs): CredentialBody {
  const mode = args.mode;
  if (mode === "bearer") {
    if (!args.token) throw new Error("bearer mode requires --token");
    return { mode, token: args.token };
  }
  if (mode === "signed_jwt") {
    if (args.privateKey === undefined) throw new Error("signed_jwt requires --private-key-file");
    return { mode, private_key: args.privateKey };
  }
  if (mode === "header") {
    if (!args.header) throw new Error('header mode requires --header "Name=Value"');
    return { mode, headers: parsePairs(args.header) };
  }
  if (mode === "query") {
    if (!args.query) throw new Error('query mode requires --query "key=Value"');
    return { mode, query: parsePairs(args.query) };
  }
  if (mode === "basic") {
    if (!args.username || !args.password)
      throw new Error("basic mode requires --username and --password");
    return { mode, username: args.username, password: args.password };
  }
  if (mode === "aws_sigv4") {
    if (!args.accessKeyId || !args.secretAccessKey)
      throw new Error("aws_sigv4 mode requires --access-key-id and --secret-access-key");
    return {
      mode,
      access_key_id: args.accessKeyId,
      secret_access_key: args.secretAccessKey,
      ...(args.sessionToken ? { session_token: args.sessionToken } : {}),
    };
  }
  if (mode === "none") return { mode };
  throw new Error(`unknown --mode '${mode}' (bearer|header|query|basic|aws_sigv4|signed_jwt|none)`);
}

const setCommand = defineCommand({
  meta: {
    name: "set",
    description:
      "Attach a credential to a connector (scriptable; no conversation needed). Modes: bearer | header | query | basic | aws_sigv4 | signed_jwt | none.",
  },
  args: {
    "connector-id": { type: "positional", required: true, description: "Connector id" },
    mode: {
      type: "string",
      required: true,
      description: "bearer | header | query | basic | aws_sigv4 | signed_jwt | none",
    },
    "private-key-file": {
      type: "string",
      description:
        "signed_jwt: local PKCS#8 PEM file; contents are sent only to the credential endpoint",
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
    return withCommandErrors(
      async () => {
        if (mode === "signed_jwt" && !args["private-key-file"]) {
          throw new Error("signed_jwt requires --private-key-file");
        }
        const body = credentialBody({
          mode,
          token: args.token,
          privateKey:
            mode === "signed_jwt"
              ? await readFile(String(args["private-key-file"]), "utf8")
              : undefined,
          header: args.header,
          query: args.query,
          username: args.username,
          password: args.password,
          accessKeyId: args["access-key-id"],
          secretAccessKey: args["secret-access-key"],
          sessionToken: args["session-token"],
        });

        const created = await client.createCredential(connectorId, body);
        let probe: { ok: boolean; error?: string } | undefined;
        if (!args["skip-checks"]) {
          try {
            const result = await client.testConnector(connectorId);
            probe = { ok: result.ok === true };
          } catch {
            probe = { ok: false, error: "probe_failed" };
          }
        }
        if (jsonMode) {
          process.stdout.write(`${JSON.stringify({ ...created, ...(probe ? { probe } : {}) })}\n`);
        } else {
          process.stdout.write(`✓ credential attached to ${connectorId}\n`);
          if (probe) process.stdout.write(probe.ok ? "✓ probe ok\n" : "⚠ probe did not succeed\n");
        }
        if (probe && !probe.ok) process.exitCode = 1;
      },
      { json: jsonMode },
    );
  },
});

const rotateCommand = defineCommand({
  meta: { name: "rotate", description: "Rotate a credential" },
  args: {
    "credential-id": { type: "positional", required: true, description: "Credential id" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      await client.rotateCredential(args["credential-id"]);
      process.stdout.write("rotated\n");
    });
  },
});

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a credential" },
  args: {
    "credential-id": { type: "positional", required: true, description: "Credential id" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      await client.deleteCredential(args["credential-id"]);
      process.stdout.write("deleted\n");
    });
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
