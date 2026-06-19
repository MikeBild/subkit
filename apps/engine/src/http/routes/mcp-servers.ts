// Tenant-scoped CRUD for external MCP servers.
//
// The inverse direction from subkit's own MCP server: tenants register
// external MCP servers whose tools the conversation loop's LLM can invoke.
// Every route here is gated on `mcp_server:manage` and tenant-scoped via
// `requireAuth(c).tenant_id` — the registry repeats the tenant predicate at
// every query, and these routes never pass an `id` without the tenant id.
//
// SECRET DISCIPLINE: the write-only `token` / `username` / `refresh_token`
// credential fields a caller supplies on create/patch are encrypted into
// the `credentials` table keyed by `mcp_server_id` — they NEVER land in
// `auth_config`, the response, a log, or an audit row. `auth_config`
// carries only the non-secret shape (`kind` + oauth2
// issuer/client_id/scope) and is redacted to `{ kind, has_credential }`
// on every read path.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam, mcpNamespaceSchema } from "../../api/common-schemas.ts";
import { readRequestSource } from "../../audit/index.ts";
import { upsertCredential } from "../../credentials/index.ts";
import {
  createMcpServer,
  deleteMcpServer,
  evictServer,
  getMcpServer,
  getTenantMcpTools,
  listMcpServers,
  MCP_CREDENTIAL_ENVIRONMENT,
  type McpServerAuditCtx,
  type McpServerAuthConfig,
  type McpServerRow,
  parseAuthConfig,
  setMcpServerStatus,
  updateMcpServer,
} from "../../mcp/index.ts";
import { NotFoundError, UnprocessableEntityError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

// ── Zod schemas ──────────────────────────────────────────────────────────────

// Mirrors the DB CHECK on `mcp_servers.namespace` EXACTLY (shared single
// source of truth in `api/common-schemas.ts`) so a bad slug is a 422-able
// boundary error, not a raw 23514 SQL error downstream.
const NamespaceSchema = mcpNamespaceSchema;

// `auth_config` carries ONLY the non-secret shape. `.strict()` rejects
// any inline secret key (token, client_secret, api_key, …) at the
// boundary — the secret is supplied separately as a top-level write-only
// field and stored encrypted in `credentials`, never on the row.
const AuthConfigInput = z
  .object({
    kind: z.enum(["none", "bearer", "basic", "oauth2"]),
    issuer: z.string().url().optional(),
    client_id: z.string().optional(),
    scope: z.string().optional(),
  })
  .strict()
  .openapi("McpServerAuthConfigInput");

// Write-only secret fields. NEVER echoed back; encrypted into the
// `credentials` table keyed by `mcp_server_id`. For `bearer`, supply
// `token`; for `basic`, supply `username` + `token` (sent as an RFC 7617
// `Authorization: Basic base64(username:token)` header at handshake); for
// `oauth2`, either supply `refresh_token` up front or omit it and run the
// interactive `POST /{id}/authorize` consent flow, which mints and
// persists the token pair itself.
const CreateMcpServerBody = z
  .object({
    name: z.string().min(1),
    namespace: NamespaceSchema,
    // stdio is out of scope for v1 (no per-tenant sandbox on a hosted engine).
    transport: z.enum(["http", "sse"]),
    url: z.string().url(),
    auth_config: AuthConfigInput.nullable().optional(),
    /** Write-only secret. Required when auth_config.kind = bearer or basic. */
    token: z.string().min(1).optional(),
    /** Write-only basic-auth username; stored encrypted with the token. */
    username: z.string().min(1).optional(),
    /** Write-only oauth2 refresh token. Optional: absent means the
     *  interactive authorize flow supplies the credential. */
    refresh_token: z.string().min(1).optional(),
  })
  .openapi("CreateMcpServerBody");

const PatchMcpServerBody = z
  .object({
    name: z.string().min(1).optional(),
    namespace: NamespaceSchema.optional(),
    transport: z.enum(["http", "sse"]).optional(),
    url: z.string().url().optional(),
    auth_config: AuthConfigInput.nullable().optional(),
    /** Write-only bearer/basic secret rotation. */
    token: z.string().min(1).optional(),
    /** Write-only basic-auth username rotation (paired with token). */
    username: z.string().min(1).optional(),
    /** Write-only oauth2 refresh-token rotation. */
    refresh_token: z.string().min(1).optional(),
  })
  .openapi("PatchMcpServerBody");

// Redacted auth shape — `kind` plus a boolean presence flag. NEVER any
// secret. `has_credential` reflects whether the server has an owned
// auth credential (i.e. kind !== "none").
const RedactedAuthConfigSchema = z
  .object({
    kind: z.enum(["none", "bearer", "basic", "oauth2"]),
    has_credential: z.boolean(),
  })
  .openapi("McpServerRedactedAuthConfig");

const McpServerResponse = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    namespace: z.string(),
    transport: z.enum(["http", "sse", "stdio"]),
    url: z.string(),
    auth_config: RedactedAuthConfigSchema,
    status: z.enum(["active", "disabled", "error"]),
    last_handshake_at: z.string().nullable(),
    last_error: z.string().nullable(),
    tools_manifest_hash: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("McpServer");

const McpServerListResponse = z
  .object({ items: z.array(McpServerResponse) })
  .openapi("McpServerListResponse");

const RemoteToolDescriptorSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.any()),
  })
  .openapi("McpRemoteToolDescriptor");

const InspectMcpServerResponse = z
  .object({
    tools: z.array(RemoteToolDescriptorSchema),
    manifest_hash: z.string().nullable(),
    last_handshake_at: z.string().nullable(),
    status: z.enum(["active", "disabled", "error"]),
    last_error: z.string().nullable(),
  })
  .openapi("InspectMcpServerResponse");

// ── Redaction ─────────────────────────────────────────────────────────────────

/** Project a row's opaque `auth_config` jsonb to the redacted public shape.
 *  Never returns any secret. `has_credential` is derived from the kind:
 *  any non-`none` kind has an owned credential in the `credentials` table. */
function redactAuthConfig(raw: Record<string, unknown> | null): {
  kind: McpServerAuthConfig["kind"];
  has_credential: boolean;
} {
  const parsed = parseAuthConfig(raw ?? null);
  return { kind: parsed.kind, has_credential: parsed.kind !== "none" };
}

/** Normalize a validated auth_config body into the typed
 *  `McpServerAuthConfig`, dropping keys whose value is `undefined` so the
 *  result satisfies `exactOptionalPropertyTypes`. */
function normalizeAuthConfig(input: z.infer<typeof AuthConfigInput>): McpServerAuthConfig {
  const out: McpServerAuthConfig = { kind: input.kind };
  if (input.issuer !== undefined) out.issuer = input.issuer;
  if (input.client_id !== undefined) out.client_id = input.client_id;
  if (input.scope !== undefined) out.scope = input.scope;
  return out;
}

/**
 * Persist the write-only secret a create/patch supplied into the
 * `credentials` table keyed by `mcp_server_id`. The secret never touches
 * `auth_config`, the response, a log, or an audit detail — only the
 * encrypted credential row. Throws a 422-able BadRequest-shaped Zod-style
 * error path via the caller when the secret is missing for a kind that
 * needs one (validated in the handler before this is called).
 *
 *   - bearer : `token` → mode "bearer", stored as the bearer value.
 *   - basic  : `username` + `token` → mode "basic"; the pool renders them
 *     as an RFC 7617 `Authorization: Basic` header at handshake.
 *   - oauth2 : `refresh_token` → mode "oauth2" with an empty access token
 *     and an already-expired expiry, so the pool runs the refresh-token
 *     grant (using auth_config.issuer/client_id/scope) on first handshake.
 */
async function writeMcpServerCredential(
  db: Parameters<typeof upsertCredential>[1],
  args: {
    tenant_id: string;
    mcp_server_id: string;
    actor_id: string | null;
    kind: "bearer" | "basic" | "oauth2";
    token?: string | undefined;
    username?: string | undefined;
    refresh_token?: string | undefined;
    scope?: string | undefined;
  },
): Promise<void> {
  if (args.kind === "bearer") {
    await upsertCredential(
      {
        tenant_id: args.tenant_id,
        mcp_server_id: args.mcp_server_id,
        environment: MCP_CREDENTIAL_ENVIRONMENT,
        mode: "bearer",
        value: { mode: "bearer", token: args.token! },
        actor_id: args.actor_id,
        source: "http_route",
      },
      db,
    );
    return;
  }
  if (args.kind === "basic") {
    await upsertCredential(
      {
        tenant_id: args.tenant_id,
        mcp_server_id: args.mcp_server_id,
        environment: MCP_CREDENTIAL_ENVIRONMENT,
        mode: "basic",
        value: { mode: "basic", username: args.username!, password: args.token! },
        actor_id: args.actor_id,
        source: "http_route",
      },
      db,
    );
    return;
  }
  // oauth2: store the refresh token; mint the access token on first
  // handshake. An epoch-0 expiry forces the pool's refresh path.
  await upsertCredential(
    {
      tenant_id: args.tenant_id,
      mcp_server_id: args.mcp_server_id,
      environment: MCP_CREDENTIAL_ENVIRONMENT,
      mode: "oauth2",
      value: {
        mode: "oauth2",
        access_token: "",
        token_type: "Bearer",
        ...(args.scope !== undefined ? { scope: args.scope } : {}),
      },
      oauth2_refresh_token: args.refresh_token!,
      oauth2_expires_at: new Date(0),
      actor_id: args.actor_id,
      source: "http_route",
    },
    db,
  );
}

function toResponse(row: McpServerRow): z.infer<typeof McpServerResponse> {
  return {
    id: row.id,
    name: row.name,
    namespace: row.namespace,
    transport: row.transport,
    url: row.url,
    auth_config: redactAuthConfig(row.auth_config ?? null),
    status: row.status,
    last_handshake_at: row.last_handshake_at ? row.last_handshake_at.toISOString() : null,
    last_error: row.last_error ?? null,
    tools_manifest_hash: row.tools_manifest_hash ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** Build the audit envelope from the request principal.
 *  Passes the request-scoped `db` as `executor` so audit writes land in
 *  the same connection pool the route already uses — consistent with the
 *  `oauth-clients.ts` pattern and required for integration-test isolation
 *  (otherwise `writeAudit` falls back to `getDb()` which points at the
 *  global pool, not the disposable test database). */
function auditCtx(
  c: Parameters<Parameters<OpenAPIHono<AppEnv>["openapi"]>[1]>[0],
  actorId: string | null,
  // When the route wraps its writes in a transaction, pass the tx so the
  // audit rows commit/rollback atomically with the row + credential write.
  executor?: McpServerAuditCtx["executor"],
): McpServerAuditCtx {
  return {
    actor_id: actorId,
    request_source: readRequestSource(c) ?? "api",
    executor: executor ?? c.get("db"),
  };
}

/** The write-only credential fields a create/patch may carry. */
interface SecretFields {
  token?: string | undefined;
  username?: string | undefined;
  refresh_token?: string | undefined;
}

/** `none`: no secret field of any kind may be present. */
function assertNoneSecretShape(s: SecretFields): void {
  if (s.token !== undefined || s.refresh_token !== undefined || s.username !== undefined) {
    throw new UnprocessableEntityError("auth_config.kind 'none' must not carry a secret");
  }
}

/** `bearer`: the secret is `token`; `refresh_token` / `username` are the
 *  wrong fields. When `requireSecret`, a `token` must be supplied. */
function assertBearerSecretShape(s: SecretFields, requireSecret: boolean): void {
  if (s.refresh_token !== undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'bearer' uses the 'token' field, not 'refresh_token'",
    );
  }
  if (s.username !== undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'bearer' does not use 'username' — that field belongs to kind 'basic'",
    );
  }
  if (requireSecret && s.token === undefined) {
    throw new UnprocessableEntityError("auth_config.kind 'bearer' requires a 'token'");
  }
}

/** `basic`: the credential is the `username` + `token` pair, rotated
 *  atomically — one without the other is always a 422 (a half-rotated
 *  basic credential is unusable). When `requireSecret`, both must be
 *  supplied. */
function assertBasicSecretShape(s: SecretFields, requireSecret: boolean): void {
  if (s.refresh_token !== undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'basic' uses 'username' + 'token', not 'refresh_token'",
    );
  }
  if ((s.username === undefined) !== (s.token === undefined)) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'basic' requires 'username' and 'token' together",
    );
  }
  if (requireSecret && s.token === undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'basic' requires a 'username' and a 'token'",
    );
  }
}

/** `oauth2`: the secret is `refresh_token`; `token` / `username` are the
 *  wrong fields. The refresh token is OPTIONAL even on create — absent
 *  means the interactive `POST /{id}/authorize` consent flow mints and
 *  persists the token pair (the server parks in error+backoff until then,
 *  the same degradation as any unauthorized handshake). */
function assertOAuth2SecretShape(s: SecretFields): void {
  if (s.token !== undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'oauth2' uses the 'refresh_token' field, not 'token'",
    );
  }
  if (s.username !== undefined) {
    throw new UnprocessableEntityError(
      "auth_config.kind 'oauth2' does not use 'username' — that field belongs to kind 'basic'",
    );
  }
}

/** Reject a create/patch whose write-only secret does not match the
 *  declared `auth_config.kind`, dispatching to the named per-kind shape
 *  check so the error message is unambiguous about which field belongs to
 *  which kind. Never echoes the secret. `requireSecret` defaults to true
 *  (create path); the patch path passes false when no rotation was
 *  requested so an unchanged-secret kind is allowed. */
function assertSecretMatchesKind(
  kind: "none" | "bearer" | "basic" | "oauth2",
  secrets: SecretFields,
  opts?: { requireSecret?: boolean },
): void {
  const requireSecret = opts?.requireSecret ?? true;
  switch (kind) {
    case "none":
      assertNoneSecretShape(secrets);
      return;
    case "bearer":
      assertBearerSecretShape(secrets, requireSecret);
      return;
    case "basic":
      assertBasicSecretShape(secrets, requireSecret);
      return;
    case "oauth2":
      assertOAuth2SecretShape(secrets);
      return;
  }
}

// ── Route definitions ────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/v1/mcp-servers",
  tags: ["mcp-servers"],
  summary: "List registered external MCP servers (auth_config redacted)",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: McpServerListResponse } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/v1/mcp-servers",
  tags: ["mcp-servers"],
  summary: "Register an external MCP server",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: CreateMcpServerBody } }, required: true },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: McpServerResponse } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Invalid", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/v1/mcp-servers/{id}",
  tags: ["mcp-servers"],
  summary: "Get a registered external MCP server (auth_config redacted)",
  request: { params: IdParam },
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: McpServerResponse } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/v1/mcp-servers/{id}",
  tags: ["mcp-servers"],
  summary: "Update a registered external MCP server",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: PatchMcpServerBody } }, required: true },
  },
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: McpServerResponse } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Invalid", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const enableRoute = createRoute({
  method: "post",
  path: "/v1/mcp-servers/{id}/enable",
  tags: ["mcp-servers"],
  summary: "Re-enable a disabled external MCP server",
  request: { params: IdParam },
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: McpServerResponse } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const disableRoute = createRoute({
  method: "post",
  path: "/v1/mcp-servers/{id}/disable",
  tags: ["mcp-servers"],
  summary: "Disable an external MCP server and evict its live clients",
  request: { params: IdParam },
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: McpServerResponse } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const inspectRoute = createRoute({
  method: "post",
  path: "/v1/mcp-servers/{id}/inspect",
  tags: ["mcp-servers"],
  summary: "Force a handshake and return the server's live tool manifest",
  request: { params: IdParam },
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: InspectMcpServerResponse } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRouteDef = createRoute({
  method: "delete",
  path: "/v1/mcp-servers/{id}",
  tags: ["mcp-servers"],
  summary: "Delete an external MCP server and evict its live clients",
  request: { params: IdParam },
  security: [{ bearerAuth: [] }],
  responses: {
    204: { description: "Deleted" },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ── Registration ─────────────────────────────────────────────────────────────

export function registerMcpServerRoutes(app: OpenAPIHono<AppEnv>): void {
  // All routes share the single `mcp_server:manage` permission.
  const gate = requirePermission("mcp_server:manage");
  app.use("/v1/mcp-servers", gate);
  app.use("/v1/mcp-servers/:id", gate);
  app.use("/v1/mcp-servers/:id/enable", gate);
  app.use("/v1/mcp-servers/:id/disable", gate);
  app.use("/v1/mcp-servers/:id/inspect", gate);

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const rows = await listMcpServers(db, principal.tenant_id);
    return c.json({ items: rows.map(toResponse) }, 200);
  });

  app.openapi(createRouteDef, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const kind = body.auth_config?.kind ?? "none";
    // Validate the write-only secret against the kind BEFORE any write, so
    // a misconfigured auth kind is a 422 with no half-created row. The
    // secret never appears in the error detail.
    assertSecretMatchesKind(kind, {
      token: body.token,
      username: body.username,
      refresh_token: body.refresh_token,
    });

    // Atomic create + credential write: the row and its owned credential
    // land in one transaction so a credential-write failure rolls back the
    // server row (no orphaned bearer/basic server with no secret). An
    // oauth2 create without a refresh_token deliberately writes NO
    // credential — the interactive authorize flow supplies it.
    const hasSecret =
      body.token !== undefined || body.username !== undefined || body.refresh_token !== undefined;
    const row = await db.transaction(async (tx) => {
      const created = await createMcpServer(
        tx,
        {
          tenant_id: principal.tenant_id,
          name: body.name,
          namespace: body.namespace,
          transport: body.transport,
          url: body.url,
          ...(body.auth_config ? { auth_config: normalizeAuthConfig(body.auth_config) } : {}),
        },
        auditCtx(c, principal.id, tx),
      );
      if (kind !== "none" && hasSecret) {
        await writeMcpServerCredential(tx, {
          tenant_id: principal.tenant_id,
          mcp_server_id: created.id,
          actor_id: principal.id,
          kind,
          token: body.token,
          username: body.username,
          refresh_token: body.refresh_token,
          scope: body.auth_config?.scope,
        });
      }
      return created;
    });
    return c.json(toResponse(row), 201);
  });

  app.openapi(getRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const row = await getMcpServer(db, principal.tenant_id, id);
    if (!row) throw new NotFoundError("mcp_server");
    return c.json(toResponse(row), 200);
  });

  app.openapi(patchRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    // A secret may only be (re)written when this PATCH also declares the
    // matching `auth_config.kind`, so the credential mode and the row's
    // auth shape can never diverge. A secret field without an auth_config
    // is a 422 — there is no kind to bind the secret to.
    const hasSecret =
      body.token !== undefined || body.username !== undefined || body.refresh_token !== undefined;
    if (hasSecret && body.auth_config == null) {
      throw new UnprocessableEntityError(
        "a token / username / refresh_token rotation requires auth_config with the matching kind",
      );
    }
    if (body.auth_config) {
      assertSecretMatchesKind(
        body.auth_config.kind,
        { token: body.token, username: body.username, refresh_token: body.refresh_token },
        {
          // On patch the secret is OPTIONAL when the kind is unchanged-secret
          // (the existing credential stays). Require it only when one was sent.
          requireSecret: hasSecret,
        },
      );
    }

    const row = await db.transaction(async (tx) => {
      const updated = await updateMcpServer(
        tx,
        principal.tenant_id,
        id,
        {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.namespace !== undefined ? { namespace: body.namespace } : {}),
          ...(body.transport !== undefined ? { transport: body.transport } : {}),
          ...(body.url !== undefined ? { url: body.url } : {}),
          ...(body.auth_config !== undefined
            ? {
                auth_config:
                  body.auth_config === null ? null : normalizeAuthConfig(body.auth_config),
              }
            : {}),
        },
        auditCtx(c, principal.id, tx),
      );
      if (!updated) return null;
      // Rotate the owned credential when a new secret was supplied for a
      // secret-bearing kind.
      if (hasSecret && body.auth_config && body.auth_config.kind !== "none") {
        await writeMcpServerCredential(tx, {
          tenant_id: principal.tenant_id,
          mcp_server_id: id,
          actor_id: principal.id,
          kind: body.auth_config.kind,
          token: body.token,
          username: body.username,
          refresh_token: body.refresh_token,
          scope: body.auth_config.scope,
        });
      }
      return updated;
    });
    if (!row) throw new NotFoundError("mcp_server");
    // Evict just THIS server's live client so the next handshake picks up
    // the rotated credential / changed auth shape instead of a stale
    // in-memory header — without cold-reconnecting every other healthy
    // server in the tenant pool.
    if (hasSecret || body.auth_config !== undefined) evictServer(principal.tenant_id, id);
    return c.json(toResponse(row), 200);
  });

  app.openapi(enableRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const row = await setMcpServerStatus(
      db,
      principal.tenant_id,
      id,
      "active",
      auditCtx(c, principal.id),
    );
    if (!row) throw new NotFoundError("mcp_server");
    return c.json(toResponse(row), 200);
  });

  app.openapi(disableRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const row = await setMcpServerStatus(
      db,
      principal.tenant_id,
      id,
      "disabled",
      auditCtx(c, principal.id),
    );
    if (!row) throw new NotFoundError("mcp_server");
    // Drop just this server's live client so the disabled server stops
    // being reachable and its resolved credential header is no longer held
    // in memory — other servers in the tenant pool stay warm.
    evictServer(principal.tenant_id, id);
    return c.json(toResponse(row), 200);
  });

  app.openapi(inspectRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const existing = await getMcpServer(db, principal.tenant_id, id);
    if (!existing) throw new NotFoundError("mcp_server");

    // Inspect must force a real handshake REGARDLESS of status — an
    // errored-but-reachable server (e.g. one that failed before its
    // credential was written) must get a fresh attempt, not a stale
    // tools:[]. The pool only retries servers in `active` status, so park
    // an `error` server back to `active` first; a still-failing handshake
    // re-parks it to `error` with the new last_error.
    if (existing.status === "error") {
      await setMcpServerStatus(db, principal.tenant_id, id, "active", auditCtx(c, principal.id));
    }

    // Force a fresh handshake by evicting ONLY this server's cached client
    // (plus its backoff window), then letting the pool lazily reconnect it.
    // Other healthy servers in the tenant pool stay warm — an operator
    // inspecting one server must not force a cold reconnect of its siblings.
    evictServer(principal.tenant_id, id);
    const sets = await getTenantMcpTools(db, principal.tenant_id, {
      requestSource: readRequestSource(c) ?? "api",
    });
    const set = sets.find((s) => s.mcp_server_id === id);

    // Re-read the row to surface the persisted handshake state (hash,
    // last_handshake_at, status, last_error) that the pool just wrote.
    const refreshed = (await getMcpServer(db, principal.tenant_id, id)) ?? existing;
    return c.json(
      {
        tools: set?.tools ?? [],
        manifest_hash: refreshed.tools_manifest_hash ?? null,
        last_handshake_at: refreshed.last_handshake_at
          ? refreshed.last_handshake_at.toISOString()
          : null,
        status: refreshed.status,
        last_error: refreshed.last_error ?? null,
      },
      200,
    );
  });

  app.openapi(deleteRouteDef, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const deleted = await deleteMcpServer(db, principal.tenant_id, id, auditCtx(c, principal.id));
    if (!deleted) throw new NotFoundError("mcp_server");
    // Drop just THIS server's live client + backoff window so the deleted
    // server stops being reachable and its resolved credential header is no
    // longer held in memory — parity with PATCH/disable/inspect; the other
    // healthy servers in the tenant pool stay warm.
    evictServer(principal.tenant_id, id);
    return c.body(null, 204);
  });
}
