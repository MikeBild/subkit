// `sk mcp-servers` — manage external MCP servers (#171).
//
// The inverse direction from sk's own MCP server: tenants register
// external MCP servers whose tools the conversation loop's LLM can
// invoke. Every subcommand is gated on `mcp_server:manage` at the
// dispatcher (see `index.ts:SUB_COMMANDS`).
//
// Pattern mirrors `connectors.ts`: Citty `defineCommand` with nested
// `subCommands`, `makeClient()` from `resolveProfile`, `emitList` /
// `emitOne` / `printJson` from cli-core, and the `--json` silent-stderr
// contract. Handlers THROW via `reportError` (never `process.exit`); the
// top-level `sk` dispatcher sets the exit code.

import * as prompts from "@clack/prompts";
import { emitList, emitOne, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

// Same contract as connectors.ts:reportError — jsonMode keeps stderr
// silent so callers can pipe `sk mcp-servers list --json` into jq, then
// re-throws so the top-level dispatcher (not this handler) sets
// `process.exitCode`. Handlers must NEVER call `process.exit` directly.
function reportError(err: unknown, jsonMode: boolean): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
  } else {
    process.stderr.write(`${msg}\n`);
  }
  throw err instanceof Error ? err : new Error(msg);
}

function makeClient() {
  const profile = resolveProfile();
  return new EngineClient({
    engine_url: profile.engine_url,
    api_key: profile.api_key,
    tenant: profile.active_tenant_id,
  });
}

// Build the create/patch request body from the auth flags. The secret
// (--token / --refresh-token) is a WRITE-ONLY top-level field — the engine
// encrypts it into the credentials table keyed by the server id and never
// echoes it back. `auth_config` carries only the non-secret shape.
function buildAuthBody(args: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const authKind = args["auth-kind"] as string | undefined;
  if (!authKind) return body;
  const auth_config: Record<string, unknown> = { kind: authKind };
  if (args.issuer) auth_config.issuer = args.issuer;
  if (args["client-id"]) auth_config.client_id = args["client-id"];
  if (args.scope) auth_config.scope = args.scope;
  body.auth_config = auth_config;
  if (args.token) body.token = args.token;
  if (args["refresh-token"]) body.refresh_token = args["refresh-token"];
  return body;
}

const AUTH_ARGS = {
  "auth-kind": { type: "string" as const, description: "Auth kind: none | bearer | oauth2" },
  token: { type: "string" as const, description: "Bearer secret (write-only; bearer kind)" },
  "refresh-token": {
    type: "string" as const,
    description: "OAuth2 refresh token (write-only; oauth2 kind)",
  },
  issuer: { type: "string" as const, description: "OAuth2 issuer URL (oauth2 kind)" },
  "client-id": { type: "string" as const, description: "OAuth2 client id (oauth2 kind)" },
  scope: { type: "string" as const, description: "OAuth2 scope (oauth2 kind)" },
};

const addCommand = defineCommand({
  meta: {
    name: "add",
    description: "Register an external MCP server (auth secrets are stored encrypted by reference)",
  },
  args: {
    name: { type: "string", required: true, description: "Human-readable server name" },
    namespace: { type: "string", required: true, description: "URL-safe namespace slug" },
    transport: { type: "string", default: "http", description: "Transport: http | sse" },
    url: { type: "string", required: true, description: "Server URL" },
    ...AUTH_ARGS,
    json: { type: "boolean", description: "JSON-only output" },
  },
  async run({ args }) {
    const jsonMode = Boolean(args.json);
    const client = makeClient();
    try {
      const body: Record<string, unknown> = {
        name: args.name,
        namespace: args.namespace,
        transport: args.transport,
        url: args.url,
        ...buildAuthBody(args),
      };
      emitOne(jsonMode, (await client.createMcpServer(body)) as Record<string, unknown>);
    } catch (err) {
      reportError(err, jsonMode);
    }
  },
});

const setCredentialCommand = defineCommand({
  meta: {
    name: "set-credential",
    description: "Rotate or set an external MCP server's auth secret (write-only)",
  },
  args: {
    id: { type: "positional", required: true, description: "MCP server id" },
    ...AUTH_ARGS,
    json: { type: "boolean", description: "JSON-only output" },
  },
  async run({ args }) {
    const jsonMode = Boolean(args.json);
    const client = makeClient();
    try {
      const body = buildAuthBody(args);
      emitOne(jsonMode, (await client.patchMcpServer(args.id, body)) as Record<string, unknown>);
    } catch (err) {
      reportError(err, jsonMode);
    }
  },
});

const listCommand = defineCommand({
  meta: { name: "list", description: "List registered external MCP servers" },
  args: {
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const jsonMode = Boolean(args.json);
    const client = makeClient();
    try {
      const { items } = await client.listMcpServers();
      emitList(
        jsonMode,
        ["id", "name", "namespace", "transport", "status", "last_handshake_at"],
        items,
      );
    } catch (err) {
      reportError(err, jsonMode);
    }
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Get an external MCP server by id" },
  args: {
    id: { type: "positional", required: true, description: "MCP server id" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const jsonMode = Boolean(args.json);
    const client = makeClient();
    try {
      emitOne(jsonMode, (await client.getMcpServer(args.id)) as Record<string, unknown>);
    } catch (err) {
      reportError(err, jsonMode);
    }
  },
});

const inspectCommand = defineCommand({
  meta: {
    name: "inspect",
    description: "Force a handshake and show the server's live tool manifest",
  },
  args: {
    id: { type: "positional", required: true, description: "MCP server id" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const jsonMode = Boolean(args.json);
    const client = makeClient();
    try {
      const result = (await client.inspectMcpServer(args.id)) as {
        tools?: Array<{ name?: string; description?: string }>;
        status?: string;
        last_error?: string | null;
        manifest_hash?: string | null;
        last_handshake_at?: string | null;
      };
      if (jsonMode) {
        printJson(result);
        return;
      }
      const tools = result.tools ?? [];
      emitList(
        false,
        ["name", "description"],
        tools.map((t) => ({ name: t.name ?? "", description: t.description ?? "" })),
      );
      process.stdout.write(
        `\nstatus: ${result.status ?? "?"}${result.last_error ? `  error: ${result.last_error}` : ""}\n`,
      );
    } catch (err) {
      reportError(err, jsonMode);
    }
  },
});

const enableCommand = defineCommand({
  meta: { name: "enable", description: "Re-enable a disabled external MCP server" },
  args: {
    id: { type: "positional", required: true, description: "MCP server id" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const jsonMode = Boolean(args.json);
    const client = makeClient();
    try {
      emitOne(jsonMode, (await client.enableMcpServer(args.id)) as Record<string, unknown>);
    } catch (err) {
      reportError(err, jsonMode);
    }
  },
});

const disableCommand = defineCommand({
  meta: {
    name: "disable",
    description: "Disable an external MCP server and evict its live clients",
  },
  args: {
    id: { type: "positional", required: true, description: "MCP server id" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const jsonMode = Boolean(args.json);
    const client = makeClient();
    try {
      emitOne(jsonMode, (await client.disableMcpServer(args.id)) as Record<string, unknown>);
    } catch (err) {
      reportError(err, jsonMode);
    }
  },
});

const removeCommand = defineCommand({
  meta: { name: "remove", description: "Delete an external MCP server" },
  args: {
    id: { type: "positional", required: true, description: "MCP server id" },
    yes: { type: "boolean", description: "Skip confirmation" },
  },
  async run({ args }) {
    if (!args.yes) {
      const confirmed = await prompts.confirm({ message: `Delete MCP server "${args.id}"?` });
      if (!confirmed || prompts.isCancel(confirmed)) return;
    }
    const client = makeClient();
    try {
      await client.deleteMcpServer(args.id);
      process.stdout.write("deleted\n");
    } catch (err) {
      reportError(err, false);
    }
  },
});

export const mcpServersCommand = defineCommand({
  meta: { name: "mcp-servers", description: "Manage external MCP servers" },
  subCommands: {
    add: addCommand,
    "set-credential": setCredentialCommand,
    list: listCommand,
    get: getCommand,
    inspect: inspectCommand,
    enable: enableCommand,
    disable: disableCommand,
    remove: removeCommand,
  },
});
