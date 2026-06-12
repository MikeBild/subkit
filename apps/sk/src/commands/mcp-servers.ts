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
// contract. Handlers THROW via `reportCommandError` (never `process.exit`); the
// top-level `sk` dispatcher sets the exit code.

import * as prompts from "@clack/prompts";
import { reportCommandError } from "@cli-core/errors";
import { emitList, emitOne, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { z } from "zod";
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

// Validated shape of the `--auth-kind` flag family. Mirrors the engine's
// per-kind secret rules so a mismatched flag combination fails locally with
// a friendly message instead of an engine 422:
//   none   → no secret of any kind
//   bearer → the secret is --token; --refresh-token / --username are the
//            wrong flags (--token itself is optional: set-credential may
//            rotate only the non-secret shape; the engine enforces
//            required-at-create)
//   basic  → the credential is --username plus --token, always together
//   oauth2 → the secret is --refresh-token (optional: the interactive
//            `authorize` flow can mint it); --token / --username are the
//            wrong flags
const AuthFlagsSchema = z
  .object({
    kind: z.enum(["none", "bearer", "basic", "oauth2"], {
      message: "--auth-kind must be one of: none, bearer, basic, oauth2",
    }),
    token: z.string().min(1, "--token must not be empty").optional(),
    username: z.string().min(1, "--username must not be empty").optional(),
    refresh_token: z.string().min(1, "--refresh-token must not be empty").optional(),
    issuer: z.string().optional(),
    client_id: z.string().optional(),
    scope: z.string().optional(),
  })
  .superRefine((v, issues) => {
    if (
      v.kind === "none" &&
      (v.token !== undefined || v.refresh_token !== undefined || v.username !== undefined)
    ) {
      issues.addIssue({
        code: "custom",
        message: "--auth-kind none must not carry --token, --username, or --refresh-token",
      });
    }
    if (v.kind === "bearer" && (v.refresh_token !== undefined || v.username !== undefined)) {
      issues.addIssue({
        code: "custom",
        message: "--auth-kind bearer uses --token, not --refresh-token or --username",
      });
    }
    if (v.kind === "basic") {
      if (v.refresh_token !== undefined) {
        issues.addIssue({
          code: "custom",
          message: "--auth-kind basic uses --username plus --token, not --refresh-token",
        });
      }
      if ((v.username === undefined) !== (v.token === undefined)) {
        issues.addIssue({
          code: "custom",
          message: "--auth-kind basic requires --username and --token together",
        });
      }
    }
    if (v.kind === "oauth2" && (v.token !== undefined || v.username !== undefined)) {
      issues.addIssue({
        code: "custom",
        message: "--auth-kind oauth2 uses --refresh-token, not --token or --username",
      });
    }
  });

// Build the create/patch request body from the auth flags, after validating
// the kind + secret combination locally. The secret (--token /
// --refresh-token) is a WRITE-ONLY top-level field — the engine encrypts it
// into the credentials table keyed by the server id and never echoes it
// back. `auth_config` carries only the non-secret shape. Throws a friendly
// Error (never echoing a secret value) on a mismatched combination.
function buildAuthBody(args: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const authKind = args["auth-kind"] as string | undefined;
  if (!authKind) {
    // A secret with no --auth-kind has no kind to bind to — reject locally
    // with the actionable message (the engine would 422 anyway).
    if (args.token || args.username || args["refresh-token"]) {
      throw new Error(
        "--token / --username / --refresh-token requires --auth-kind (bearer, basic, or oauth2)",
      );
    }
    return body;
  }
  const parsed = AuthFlagsSchema.safeParse({
    kind: authKind,
    token: args.token === undefined ? undefined : String(args.token),
    username: args.username === undefined ? undefined : String(args.username),
    refresh_token: args["refresh-token"] === undefined ? undefined : String(args["refresh-token"]),
    issuer: args.issuer === undefined ? undefined : String(args.issuer),
    client_id: args["client-id"] === undefined ? undefined : String(args["client-id"]),
    scope: args.scope === undefined ? undefined : String(args.scope),
  });
  if (!parsed.success) {
    // Issue messages name only flags, never the secret values.
    throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  }
  const flags = parsed.data;
  const auth_config: Record<string, unknown> = { kind: flags.kind };
  if (flags.issuer) auth_config.issuer = flags.issuer;
  if (flags.client_id) auth_config.client_id = flags.client_id;
  if (flags.scope) auth_config.scope = flags.scope;
  body.auth_config = auth_config;
  if (flags.token) body.token = flags.token;
  if (flags.username) body.username = flags.username;
  if (flags.refresh_token) body.refresh_token = flags.refresh_token;
  return body;
}

const AUTH_ARGS = {
  "auth-kind": {
    type: "string" as const,
    description: "Auth kind: none | bearer | basic | oauth2",
  },
  token: {
    type: "string" as const,
    description: "Secret (write-only; bearer token or basic password/API token)",
  },
  username: {
    type: "string" as const,
    description: "Basic-auth username (basic kind; paired with --token)",
  },
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
      reportCommandError(err, { json: jsonMode });
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
      reportCommandError(err, { json: jsonMode });
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
      reportCommandError(err, { json: jsonMode });
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
      reportCommandError(err, { json: jsonMode });
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
      reportCommandError(err, { json: jsonMode });
    }
  },
});

// Fire-and-forget browser open. The CLI never depends on the open
// succeeding — the URL is always printed so a headless / SSH operator can
// copy it by hand. `spawn` with an argv array (NOT a shell string): the URL
// is handed to the opener as a single argument, so no URL content can ever
// reach a shell. On win32 `start` is a cmd builtin, so it runs via
// `cmd /c start "" <url>` — the empty "" is start's window-title slot,
// keeping the URL out of that position. Detached + ignored stdio + unref so
// the CLI never waits on the browser process; a missing opener binary
// surfaces as an ignored 'error' event, not a crash.
async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {
    /* fire-and-forget: the URL was already printed for manual open */
  });
  child.unref();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Bounded, deterministic poll: 60 iterations × 2s ≈ 120s. No Date.now —
// the iteration count is the sole clock so the test harness can flip
// getMcpServer's status and have the loop terminate predictably.
const AUTHORIZE_POLL_ATTEMPTS = 60;
const AUTHORIZE_POLL_INTERVAL_MS = 2000;

const authorizeCommand = defineCommand({
  meta: {
    name: "authorize",
    description: "Run the interactive OAuth consent flow for an external MCP server",
  },
  args: {
    id: { type: "positional", required: true, description: "MCP server id" },
    json: { type: "boolean", description: "JSON-only output (no browser open, no polling)" },
    "no-open": { type: "boolean", description: "Print the URL but do not auto-open a browser" },
    "no-wait": { type: "boolean", description: "Skip polling for authorization to complete" },
  },
  async run({ args }) {
    const jsonMode = Boolean(args.json);
    const client = makeClient();
    try {
      const { authorization_url, state } = await client.authorizeMcpServer(String(args.id));

      // Machine consumers handle the browser + poll themselves: emit the
      // contract fields and stop. No stderr, no browser, no waiting.
      if (jsonMode) {
        printJson({ authorization_url, state });
        return;
      }

      process.stdout.write(`Open this URL in your browser to authorize:\n  ${authorization_url}\n`);
      if (!args["no-open"]) {
        await openBrowser(authorization_url);
      }

      if (args["no-wait"]) {
        process.stdout.write(
          "\nAfter authorizing, run `sk mcp-servers inspect <id>` to confirm the server is active.\n",
        );
        return;
      }

      process.stdout.write("\nWaiting for authorization to complete (up to 120s)...\n");
      // Poll by FORCING a handshake (inspect), not by reading the row's
      // status: a never-handshaken server already sits at the default
      // `active`, so `GET /{id}` would report success before the user even
      // opened the consent URL. Inspect only returns `active` after a real
      // handshake succeeded with the freshly minted token; until then it
      // returns `error` ("authorization required"), which just means "keep
      // waiting" here.
      for (let attempt = 0; attempt < AUTHORIZE_POLL_ATTEMPTS; attempt++) {
        await sleep(AUTHORIZE_POLL_INTERVAL_MS);
        const inspected = (await client.inspectMcpServer(String(args.id))) as {
          status?: string;
          last_error?: string | null;
        };
        if (inspected.status === "active") {
          process.stdout.write("authorized — server is active\n");
          return;
        }
      }
      process.stdout.write(
        "timed out waiting for authorization — complete the browser step, then run `sk mcp-servers inspect <id>`\n",
      );
    } catch (err) {
      reportCommandError(err, { json: jsonMode });
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
      reportCommandError(err, { json: jsonMode });
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
      reportCommandError(err, { json: jsonMode });
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
      reportCommandError(err);
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
    authorize: authorizeCommand,
    enable: enableCommand,
    disable: disableCommand,
    remove: removeCommand,
  },
});
