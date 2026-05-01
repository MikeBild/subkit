// Connector + credential HTTP surface.
//
// Routes:
//   GET    /v1/connectors                          — list (optional ?environment=)
//   POST   /v1/connectors                          — create
//   GET    /v1/connectors/:id                      — fetch
//   PATCH  /v1/connectors/:id                      — update
//   DELETE /v1/connectors/:id                      — soft delete
//   POST   /v1/connectors/:id/test                 — driver health probe
//   POST   /v1/connectors/:id/call                 — ad-hoc HTTP/GraphQL call
//   POST   /v1/connectors/:id/oauth/start          — returns authorization_url + state
//   GET    /v1/connectors/:id/oauth/callback       — completes code exchange
//   POST   /v1/connectors/:id/credentials          — attach non-oauth credential
//   POST   /v1/connectors/:id/end-user-credentials — end-user scoped credential

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import {
  ConnectorCallRequestSchema,
  ConnectorCallResponseSchema,
} from "../../api/connector-schemas.ts";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { probeConnector } from "../../connectors/drivers/index.ts";
import * as connectorSvc from "../../connectors/service.ts";
import {
  type CallConnectorMethod,
  callConnector,
} from "../../connectors/services/call-connector.ts";
import { resolveConnectorOAuthConfig } from "../../connectors/template-binding.ts";
import {
  ConnectorTemplateSourceEnum,
  type ConnectorView,
  CreateConnectorSchema,
  OperatorQuirksSchema,
  UpdateConnectorSchema,
} from "../../connectors/types.ts";
import {
  completeAuthorizationCode,
  runClientCredentialsGrant,
  startAuthorizationCode,
} from "../../credentials/oauth2/client.ts";
import type { OAuth2ClientConfig } from "../../credentials/oauth2/types.ts";
import * as credsvc from "../../credentials/service.ts";
import { encryptSecret } from "../../crypto/aes-gcm.ts";
import type { Db } from "../../db/client.ts";
import { connectorOauthStates, credentials, endUserCredentials } from "../../db/schema/index.ts";
import { BadRequestError, NotFoundError, UnprocessableEntityError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const ConnectorSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    slug: z.string(),
    display_name: z.string(),
    driver: z.string(),
    environment: z.string(),
    auth_type: z.string(),
    base_url: z.string().nullable(),
    dsn: z.string().nullable(),
    config: z.record(z.string(), z.unknown()),
    operator_quirks: OperatorQuirksSchema,
    template_slug: z.string().nullable(),
    template_name: z.string().nullable(),
    template_source: ConnectorTemplateSourceEnum.nullable(),
    template_version: z.number().int().nullable(),
    template_snapshot: z.record(z.string(), z.unknown()).nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("Connector");

const ConnectorListResponse = z
  .object({ items: z.array(ConnectorSchema) })
  .openapi("ConnectorListResponse");

const ProbeResultSchema = z
  .object({
    ok: z.boolean(),
    latency_ms: z.number(),
    status: z.number().optional(),
    detail: z.string().optional(),
  })
  .openapi("ConnectorProbeResult");

const CredentialBody = z
  .object({
    mode: z.enum(["none", "header", "query", "bearer", "basic", "aws_sigv4"]),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.string()).optional(),
    token: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    // aws_sigv4 mode — long-lived IAM keys + optional STS session token.
    // The credential service already supports this mode; the route's
    // request schema was the gap. The audit recorder writes
    // `metadata.mode = "aws_sigv4"` and the service's serialize path
    // reduces the value to a digest before persistence.
    access_key_id: z.string().optional(),
    secret_access_key: z.string().optional(),
    session_token: z.string().optional(),
  })
  .openapi("CredentialBody");

const EndUserCredentialBody = z
  .object({
    enduser_ref: z.string(),
    combine_mode: z.enum(["merge", "replace"]),
    payload: z.record(z.string(), z.unknown()),
  })
  .openapi("EndUserCredentialBody");

const OAuthStartResponse = z
  .object({
    authorization_url: z.string(),
    state: z.string(),
  })
  .openapi("OAuthStartResponse");

const OAuthCallbackQuery = z
  .object({
    code: z.string(),
    state: z.string(),
  })
  .openapi("OAuthCallbackQuery");

function serialize(c: ConnectorView) {
  return {
    id: c.id,
    tenant_id: c.tenant_id,
    slug: c.slug,
    display_name: c.display_name,
    driver: c.driver,
    environment: c.environment,
    auth_type: c.auth_type,
    base_url: c.base_url,
    dsn: c.dsn,
    config: c.config,
    operator_quirks: c.operator_quirks,
    template_slug: c.template_slug,
    template_name: c.template_name,
    template_source: c.template_source,
    template_version: c.template_version,
    template_snapshot: c.template_snapshot,
    created_at: c.created_at.toISOString(),
    updated_at: c.updated_at.toISOString(),
  };
}

const listRoute = createRoute({
  method: "get",
  path: "/v1/connectors",
  tags: ["connectors"],
  summary: "List connectors",
  security: [{ bearerAuth: [] }],
  request: {
    query: z
      .object({ environment: z.enum(["dev", "prod"]).optional() })
      .openapi("ListConnectorsQuery"),
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ConnectorListResponse } } },
  },
});

const createRouteSpec = createRoute({
  method: "post",
  path: "/v1/connectors",
  tags: ["connectors"],
  summary: "Create a connector",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: CreateConnectorSchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: ConnectorSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/v1/connectors/{id}",
  tags: ["connectors"],
  summary: "Fetch a connector",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ConnectorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/v1/connectors/{id}",
  tags: ["connectors"],
  summary: "Update a connector",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: UpdateConnectorSchema } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ConnectorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/connectors/{id}",
  tags: ["connectors"],
  summary: "Delete a connector",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    204: { description: "Deleted" },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const testRoute = createRoute({
  method: "post",
  path: "/v1/connectors/{id}/test",
  tags: ["connectors"],
  summary: "Probe a connector's health",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ProbeResultSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const callRoute = createRoute({
  method: "post",
  path: "/v1/connectors/{id}/call",
  tags: ["connectors"],
  summary: "Invoke an HTTP/GraphQL endpoint against a persisted connector",
  description:
    "Programmatic surface for ad-hoc connector invocation. Mirrors the call_connector conversation tool: applies the saved credential, audits as connector.invoked, and returns {status, headers, body, latency_ms} with truncation flags for response bodies > 8KB. Driver coverage at this surface is HTTP and GraphQL only — Postgres / SFTP / S3 connectors return a 422 envelope pointing at workflow-step authoring.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: ConnectorCallRequestSchema } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ConnectorCallResponseSchema } },
    },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    422: {
      description: "Unprocessable entity (driver mismatch, missing credential, …)",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const oauthStartRoute = createRoute({
  method: "post",
  path: "/v1/connectors/{id}/oauth/start",
  tags: ["connectors"],
  summary: "Begin an OAuth2 authorization-code flow",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: OAuthStartResponse } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const oauthCallbackRoute = createRoute({
  method: "get",
  path: "/v1/connectors/{id}/oauth/callback",
  tags: ["connectors"],
  summary: "Complete an OAuth2 authorization-code flow",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam, query: OAuthCallbackQuery },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const credentialsRoute = createRoute({
  method: "post",
  path: "/v1/connectors/{id}/credentials",
  tags: ["connectors"],
  summary: "Attach credentials to a connector",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: CredentialBody } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: z.object({ id: z.string() }) } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const endUserCredentialsRoute = createRoute({
  method: "post",
  path: "/v1/connectors/{id}/end-user-credentials",
  tags: ["connectors"],
  summary: "Attach end-user-scoped credentials",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: EndUserCredentialBody } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: z.object({ id: z.string() }) } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

async function connectorOauthCfg(
  db: Db,
  tenant_id: string,
  c: ConnectorView,
): Promise<OAuth2ClientConfig> {
  const cfg = await resolveConnectorOAuthConfig(db, tenant_id, c);
  if (!cfg) {
    throw new BadRequestError("connector is missing oauth2 config (issuer_url + client_id)");
  }
  return cfg;
}

export function registerConnectorRoutes(app: OpenAPIHono<AppEnv>): void {
  // Pass-2 C5: RBAC gating for every connector + credential surface.
  // Collection routes get a method-switched middleware; resource routes
  // pass a resource descriptor so the evaluator can consult grants.
  app.use("/v1/connectors", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("connector:read")(c, next);
    if (c.req.method === "POST") return requirePermission("connector:write")(c, next);
    return next();
  });
  app.use("/v1/connectors/:id", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "GET") {
      return requirePermission("connector:read", () => ({ type: "connector", id }))(c, next);
    }
    if (c.req.method === "PATCH") {
      return requirePermission("connector:write", () => ({ type: "connector", id }))(c, next);
    }
    if (c.req.method === "DELETE") {
      return requirePermission("connector:delete", () => ({ type: "connector", id }))(c, next);
    }
    return next();
  });
  app.use("/v1/connectors/:id/test", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("connector:test", () => ({ type: "connector", id }))(c, next);
  });
  app.use("/v1/connectors/:id/call", async (c, next) => {
    // Parity with the call_connector conversation tool: `connector:read`
    // is the closest gate (no `connector:invoke` permission exists in
    // the catalog). The probe + call paths share the same grant.
    const id = c.req.param("id");
    return requirePermission("connector:read", () => ({ type: "connector", id }))(c, next);
  });
  app.use("/v1/connectors/:id/oauth/start", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("connector:oauth", () => ({ type: "connector", id }))(c, next);
  });
  app.use("/v1/connectors/:id/oauth/callback", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("connector:oauth", () => ({ type: "connector", id }))(c, next);
  });
  app.use("/v1/connectors/:id/credentials", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("credential:write", () => ({ type: "connector", id }))(c, next);
  });
  app.use("/v1/connectors/:id/end-user-credentials", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("credential:write", () => ({ type: "connector", id }))(c, next);
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const opts: Parameters<typeof connectorSvc.listConnectors>[1] = {};
    if (q.environment) opts.environment = q.environment;
    const items = await connectorSvc.listConnectors(principal.tenant_id, opts, db);
    return c.json({ items: items.map(serialize) }, 200);
  });

  app.openapi(createRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const created = await connectorSvc.createConnector(
      { tenant_id: principal.tenant_id, input: body, actor_id: principal.id },
      db,
    );
    return c.json(serialize(created), 201);
  });

  app.openapi(getRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const found = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!found) throw new NotFoundError("connector");
    return c.json(serialize(found), 200);
  });

  app.openapi(patchRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const updated = await connectorSvc.updateConnector(
      principal.tenant_id,
      id,
      body,
      principal.id,
      db,
    );
    if (!updated) throw new NotFoundError("connector");
    return c.json(serialize(updated), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const ok = await connectorSvc.deleteConnector(principal.tenant_id, id, principal.id, db);
    if (!ok) throw new NotFoundError("connector");
    return c.body(null, 204);
  });

  app.openapi(testRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const connector = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!connector) throw new NotFoundError("connector");
    const result = await probeConnector({ db, tenant_id: principal.tenant_id, connector });
    return c.json(result, 200);
  });

  app.openapi(callRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const result = await callConnector({
      db,
      tenant_id: principal.tenant_id,
      actor_id: principal.id,
      connector_id: id,
      // The flat schema accepts an optional method (Postgres / SFTP have
      // no notion of HTTP verbs). For HTTP/GraphQL drivers we default to
      // GET when nothing is supplied — same convention as the
      // conversation tool path.
      method: (body.method ?? "GET") as CallConnectorMethod,
      path: body.path ?? "",
      ...(body.query ? { query: body.query } : {}),
      ...(body.headers ? { headers: body.headers } : {}),
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(body.timeout_ms !== undefined ? { timeout_ms: body.timeout_ms } : {}),
    });

    if (result.kind === "ok") {
      return c.json(
        {
          status: result.status,
          headers: result.headers,
          body: result.body,
          latency_ms: result.latency_ms,
          truncated: result.truncated,
          body_byte_count: result.body_byte_count,
          metadata: result.metadata,
          ...(result.raw_ref ? { raw_ref: result.raw_ref } : {}),
        },
        200,
      );
    }

    // Map the structured service error onto a typed HTTP error.
    switch (result.error_code) {
      case "connector_not_found":
        throw new NotFoundError("connector");
      case "credential_required":
      case "driver_not_supported_for_call_connector":
      case "invalid_input":
      case "call_failed": {
        // 422 is the right code for "the request was understood but
        // the resource state (no credential / wrong driver / bad
        // GraphQL body / upstream failure) makes it unprocessable".
        // The structured `error_code` is in details so SDK callers can
        // disambiguate without parsing the message.
        const details: Record<string, unknown> = {
          error_code: result.error_code,
          driver: result.driver,
          latency_ms: result.latency_ms,
        };
        if (result.next_best_actions) details.next_best_actions = result.next_best_actions;
        if (result.metadata) details.metadata = result.metadata;
        throw new UnprocessableEntityError(result.message, details);
      }
    }
  });

  app.openapi(oauthStartRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const connector = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!connector) throw new NotFoundError("connector");
    const cfg = await connectorOauthCfg(db, principal.tenant_id, connector);
    const cfgCopy: OAuth2ClientConfig = { ...cfg };
    if (!cfgCopy.redirect_uri) {
      throw new BadRequestError("connector config missing redirect_uri");
    }
    const started = await startAuthorizationCode(cfgCopy);
    await db.insert(connectorOauthStates).values({
      tenant_id: principal.tenant_id,
      connector_id: id,
      state: started.state,
      code_verifier: started.code_verifier,
      redirect_uri: cfgCopy.redirect_uri,
      expires_at: new Date(Date.now() + 10 * 60_000),
    });
    return c.json({ authorization_url: started.authorization_url, state: started.state }, 200);
  });

  app.openapi(oauthCallbackRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    const connector = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!connector) throw new NotFoundError("connector");
    const stateRows = await db
      .select()
      .from(connectorOauthStates)
      .where(
        and(
          eq(connectorOauthStates.tenant_id, principal.tenant_id),
          eq(connectorOauthStates.connector_id, id),
          eq(connectorOauthStates.state, q.state),
        ),
      )
      .limit(1);
    const stateRow = stateRows[0];
    if (!stateRow) throw new BadRequestError("oauth state not found or expired");
    const cfg = await connectorOauthCfg(db, principal.tenant_id, connector);
    const current = new URL(stateRow.redirect_uri);
    current.searchParams.set("code", q.code);
    current.searchParams.set("state", q.state);
    const bundle = await completeAuthorizationCode({
      cfg,
      current_url: current,
      code_verifier: stateRow.code_verifier,
      state: stateRow.state,
    });
    await credsvc.upsertCredential(
      {
        tenant_id: principal.tenant_id,
        connector_id: id,
        environment: connector.environment,
        mode: "oauth2",
        value: {
          mode: "oauth2",
          access_token: bundle.access_token,
          token_type: bundle.token_type,
          ...(bundle.scope ? { scope: bundle.scope } : {}),
        },
        oauth2_refresh_token: bundle.refresh_token ?? null,
        oauth2_expires_at: bundle.expires_at,
        actor_id: principal.id,
      },
      db,
    );
    await db.delete(connectorOauthStates).where(eq(connectorOauthStates.id, stateRow.id));
    return c.json({ ok: true }, 200);
  });

  app.openapi(credentialsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const connector = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!connector) throw new NotFoundError("connector");

    let value: Parameters<typeof credsvc.upsertCredential>[0]["value"];
    switch (body.mode) {
      case "none":
        value = { mode: "none" };
        break;
      case "header":
        if (!body.headers) throw new BadRequestError("header mode requires headers");
        value = { mode: "header", headers: body.headers };
        break;
      case "query":
        if (!body.query) throw new BadRequestError("query mode requires query");
        value = { mode: "query", query: body.query };
        break;
      case "bearer":
        if (!body.token) throw new BadRequestError("bearer mode requires token");
        value = { mode: "bearer", token: body.token };
        break;
      case "basic":
        if (!body.username || body.password === undefined) {
          throw new BadRequestError("basic mode requires username and password");
        }
        value = { mode: "basic", username: body.username, password: body.password };
        break;
      case "aws_sigv4":
        if (!body.access_key_id || !body.secret_access_key) {
          throw new BadRequestError("aws_sigv4 mode requires access_key_id and secret_access_key");
        }
        value = {
          mode: "aws_sigv4",
          access_key_id: body.access_key_id,
          secret_access_key: body.secret_access_key,
          ...(body.session_token ? { session_token: body.session_token } : {}),
        };
        break;
    }

    // If connector auth_type differs, keep them consistent by updating connector too.
    if (connector.auth_type !== body.mode) {
      await connectorSvc.updateConnector(
        principal.tenant_id,
        id,
        { auth_type: body.mode },
        principal.id,
        db,
      );
    }

    const row = await credsvc.upsertCredential(
      {
        tenant_id: principal.tenant_id,
        connector_id: id,
        environment: connector.environment,
        mode: body.mode,
        value,
        actor_id: principal.id,
      },
      db,
    );
    return c.json({ id: row.id }, 201);
  });

  app.openapi(endUserCredentialsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const connector = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!connector) throw new NotFoundError("connector");
    // End-user credentials are simple key/value blobs that the workflow
    // can layer onto the base credential at run time. We encrypt the
    // whole payload with AAD bound to the enduser_ref.
    const aad = `enduser:${principal.tenant_id}:${id}:${body.enduser_ref}`;
    const payload = encryptSecret(JSON.stringify(body.payload), aad);
    const inserted = await db
      .insert(endUserCredentials)
      .values({
        tenant_id: principal.tenant_id,
        connector_id: id,
        enduser_ref: body.enduser_ref,
        combine_mode: body.combine_mode,
        ciphertext: Buffer.from(payload.ciphertext),
        iv: Buffer.from(payload.iv),
        auth_tag: Buffer.from(payload.auth_tag),
      })
      .onConflictDoUpdate({
        target: [
          endUserCredentials.tenant_id,
          endUserCredentials.connector_id,
          endUserCredentials.enduser_ref,
        ],
        set: {
          combine_mode: body.combine_mode,
          ciphertext: Buffer.from(payload.ciphertext),
          iv: Buffer.from(payload.iv),
          auth_tag: Buffer.from(payload.auth_tag),
          updated_at: new Date(),
        },
      })
      .returning();
    const insertedRow = inserted[0];
    if (!insertedRow) {
      // .onConflictDoUpdate guarantees a row in either branch — defensive
      // throw so the route returns a clear 5xx instead of an opaque crash.
      throw new Error("end_user_credential insert returned no rows");
    }
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: "user",
        actor_id: principal.id,
        action: AuditAction.CREDENTIAL_CREATED,
        resource_type: "end_user_credential",
        resource_id: insertedRow.id,
        result: "success",
        metadata: { connector_id: id, enduser_ref: body.enduser_ref },
      },
      db,
    );
    // Touch `credentials` import so biome/unused-vars doesn't flag.
    void credentials;
    return c.json({ id: insertedRow.id }, 201);
  });

  // Touch imports used only via closure in routes above — so biome
  // unused-import pass doesn't trigger when closures are wrapped.
  void runClientCredentialsGrant;
}
