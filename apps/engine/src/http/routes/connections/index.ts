// Outbound connections — the Cockpit's "Kontoverbindungen" (a section of Zugangsdaten).
//
//   POST   /v1/connections/discover      what is at this address? (name, scopes, connectable?)
//   POST   /v1/connections/start         register there, mint PKCE, return the authorization URL
//   GET    /v1/connections/callback      UNAUTHENTICATED — the other side redirects here;
//                                        `state` is the credential. Ends in the Cockpit.
//   GET    /v1/connections               every connection of this tenant, with its state
//   GET    /v1/connections/{id}
//   POST   /v1/connections/{id}/renew    "Erneuern": the same flow again for this row
//   DELETE /v1/connections/{id}          "Trennen"
//
// The callback never renders a page of its own: success and failure both
// land on the grants section of /cockpit/api-access with a query the page
// turns into a sentence.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { ConnectionStateEnum, ConnectionStateReasonEnum } from "../../../api/connection-schemas.ts";
import {
  buildConnectionCallbackUri,
  ConnectionError,
  completeConnection,
  disconnectConnection,
  discoverService,
  getConnection,
  listConnections,
  resolvePublicOrigin,
  startConnection,
} from "../../../credentials/index.ts";
import { logger } from "../../../logging/index.ts";
import { BadRequestError, ConflictError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

const ConnectionUserSchema = z
  .object({
    connector_id: z.string(),
    slug: z.string(),
    display_name: z.string(),
    /** Live workflows that use this connector (`workflows/connector-refs.ts`). */
    workflow_count: z.number().int().nonnegative(),
  })
  .openapi("ConnectionUser");

const ConnectionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    base_url: z.string(),
    issuer: z.string(),
    service_name: z.string().nullable(),
    service_description: z.string().nullable(),
    scopes: z.array(z.string()),
    granted_scopes: z.array(z.string()).nullable(),
    state: ConnectionStateEnum,
    state_reason: ConnectionStateReasonEnum.nullable(),
    auto_renew: z.boolean(),
    expires_at: z.string().nullable(),
    last_used_at: z.string().nullable(),
    last_refreshed_at: z.string().nullable(),
    refresh_failed_at: z.string().nullable(),
    last_error: z.string().nullable(),
    used_by: z.array(ConnectionUserSchema),
    created_at: z.string(),
  })
  .openapi("Connection");

const ConnectionListResponse = z
  .object({ items: z.array(ConnectionSchema) })
  .openapi("ConnectionListResponse");

const DiscoverBody = z
  .object({ base_url: z.string().min(1).max(2048) })
  .openapi("ConnectionDiscoverBody");

const DiscoverResponse = z
  .object({
    base_url: z.string(),
    /** Whether "Verbinden" can proceed, and if not, why in one code. */
    connectable: z.boolean(),
    reason: z.string().nullable(),
    service_name: z.string().nullable(),
    service_description: z.string().nullable(),
    service_version: z.string().nullable(),
    issuer: z.string().nullable(),
    scopes_supported: z.array(z.string()),
  })
  .openapi("ConnectionDiscoverResponse");

const StartBody = z
  .object({
    name: z.string().min(1).max(63),
    base_url: z.string().min(1).max(2048),
    scopes: z.array(z.string().min(1)).min(1).max(50),
  })
  .openapi("ConnectionStartBody");

const StartResponse = z
  .object({ authorization_url: z.string(), name: z.string() })
  .openapi("ConnectionStartResponse");

const CallbackQuery = z
  .object({
    state: z.string().min(1),
    code: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .openapi("ConnectionCallbackQuery");

const discoverRoute = createRoute({
  method: "post",
  path: "/v1/connections/discover",
  tags: ["connections"],
  summary: "Read what a server publishes about itself before connecting",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: DiscoverBody } } } },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: DiscoverResponse } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const startRoute = createRoute({
  method: "post",
  path: "/v1/connections/start",
  tags: ["connections"],
  summary: "Register at the server and begin Authorization Code with PKCE",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: StartBody } } } },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: StartResponse } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Name taken", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const callbackRoute = createRoute({
  method: "get",
  path: "/v1/connections/callback",
  tags: ["connections"],
  summary: "Complete a connection; the other side redirects the browser here",
  // Unauthenticated: the browser arrives from the other server with no
  // session header. The opaque `state` names the tenant, the person and the
  // round, and is spent exactly once.
  request: { query: CallbackQuery },
  responses: { 302: { description: "Redirect into the Cockpit" } },
});

const listRoute = createRoute({
  method: "get",
  path: "/v1/connections",
  tags: ["connections"],
  summary: "List outbound connections with their state",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ConnectionListResponse } } },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/v1/connections/{id}",
  tags: ["connections"],
  summary: "One outbound connection",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ConnectionSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const renewRoute = createRoute({
  method: "post",
  path: "/v1/connections/{id}/renew",
  tags: ["connections"],
  summary: "Repeat the authorization for an existing connection",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: StartResponse } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/connections/{id}",
  tags: ["connections"],
  summary: "Disconnect: revoke the stored tokens and forget the connection",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    204: { description: "Disconnected" },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

function rethrow(error: unknown): never {
  if (error instanceof ConnectionError) {
    if (error.code === "not_found") throw new NotFoundError("connection");
    if (error.code === "name_taken") throw new ConflictError(error.message);
    throw new BadRequestError(`${error.code}: ${error.message}`);
  }
  throw error;
}

/** Kontoverbindungen are a section of Zugangsdaten; the callback lands on it. */
function cockpitReturn(origin: string, params: Record<string, string | null>): Response {
  const url = new URL("/cockpit/api-access", origin);
  url.searchParams.set("section", "grants");
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  return new Response(null, {
    status: 302,
    headers: { location: url.toString(), "cache-control": "no-store" },
  });
}

export function registerConnectionRoutes(app: OpenAPIHono<AppEnv>): void {
  // The callback is the one path without a principal; everything else needs one.
  app.use("/v1/connections", (c, next) =>
    c.req.method === "GET"
      ? requirePermission("connection:read")(c, next)
      : requirePermission("connection:write")(c, next),
  );
  app.use("/v1/connections/discover", requirePermission("connection:write"));
  app.use("/v1/connections/start", requirePermission("connection:write"));
  app.use("/v1/connections/:id", (c, next) => {
    if (c.req.param("id") === "callback") return next();
    return c.req.method === "GET"
      ? requirePermission("connection:read")(c, next)
      : requirePermission("connection:write")(c, next);
  });
  app.use("/v1/connections/:id/renew", requirePermission("connection:write"));

  app.openapi(discoverRoute, async (c) => {
    requireAuth(c);
    const { base_url } = c.req.valid("json");
    try {
      const result = await discoverService(base_url);
      const metadata = result.authorization;
      let reason: string | null = null;
      if (!metadata) reason = "discovery_missing";
      else if (!metadata.registration_endpoint) reason = "registration_missing";
      else if (
        metadata.code_challenge_methods_supported &&
        !metadata.code_challenge_methods_supported.includes("S256")
      )
        reason = "pkce_unsupported";
      return c.json(
        {
          base_url: result.base_url,
          connectable: reason === null,
          reason,
          service_name: result.descriptor?.name ?? null,
          service_description: result.descriptor?.description ?? null,
          service_version: result.descriptor?.version ?? null,
          issuer: metadata?.issuer ?? null,
          scopes_supported: metadata?.scopes_supported ?? [],
        },
        200,
      );
    } catch (error) {
      rethrow(error);
    }
  });

  app.openapi(startRoute, async (c) => {
    const principal = requireAuth(c);
    const body = c.req.valid("json");
    const redirect_uri = buildConnectionCallbackUri({ req: c.req.raw });
    if (!redirect_uri) {
      throw new BadRequestError(
        "engine has no resolvable public origin — set server.public_base_url",
      );
    }
    try {
      const started = await startConnection(c.get("db"), {
        tenant_id: principal.tenant_id,
        user_id: principal.id,
        name: body.name,
        base_url: body.base_url,
        scopes: body.scopes,
        redirect_uri,
        client_uri: resolvePublicOrigin({ req: c.req.raw }),
      });
      return c.json({ authorization_url: started.authorization_url, name: started.name }, 200);
    } catch (error) {
      rethrow(error);
    }
  });

  app.openapi(callbackRoute, async (c) => {
    const query = c.req.valid("query");
    const origin = resolvePublicOrigin({ req: c.req.raw }) ?? new URL(c.req.url).origin;
    const result = await completeConnection(c.get("db"), {
      state: query.state,
      code: query.code,
      error: query.error,
    });
    if (result.ok) {
      return cockpitReturn(origin, {
        connected: result.name,
        renewed: result.renewed ? "1" : null,
      });
    }
    logger.warn({
      module: "connections",
      action: "connection.callback_failed",
      msg: "a connection round did not complete",
      code: result.code,
      name: result.name,
    });
    return cockpitReturn(origin, { failed: result.code, name: result.name });
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const items = await listConnections(c.get("db"), principal.tenant_id);
    return c.json({ items }, 200);
  });

  app.openapi(getRoute, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    try {
      return c.json(await getConnection(c.get("db"), principal.tenant_id, id), 200);
    } catch (error) {
      rethrow(error);
    }
  });

  app.openapi(renewRoute, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    const redirect_uri = buildConnectionCallbackUri({ req: c.req.raw });
    if (!redirect_uri) {
      throw new BadRequestError(
        "engine has no resolvable public origin — set server.public_base_url",
      );
    }
    try {
      const db = c.get("db");
      const current = await getConnection(db, principal.tenant_id, id);
      const started = await startConnection(db, {
        tenant_id: principal.tenant_id,
        user_id: principal.id,
        name: current.name,
        base_url: current.base_url,
        scopes: current.scopes,
        redirect_uri,
        client_uri: resolvePublicOrigin({ req: c.req.raw }),
        connection_id: id,
      });
      return c.json({ authorization_url: started.authorization_url, name: started.name }, 200);
    } catch (error) {
      rethrow(error);
    }
  });

  app.openapi(deleteRoute, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    try {
      await disconnectConnection(c.get("db"), {
        tenant_id: principal.tenant_id,
        id,
        actor_id: principal.id,
      });
    } catch (error) {
      rethrow(error);
    }
    return c.body(null, 204);
  });
}
