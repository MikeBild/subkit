import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { ConnectionStateEnum, ConnectionStateReasonEnum } from "../../../api/connection-schemas.ts";
import { actorOf } from "../../../audit/index.ts";
import type { SignInFailure } from "../../../connectors/index.ts";
import {
  buildConnectionCallbackUri,
  type CompleteConnectionResult,
  ConnectionError,
  type ConnectionFailureCode,
  completeConnection,
  connectorsUsingConnection,
  disconnectConnection,
  discoverService,
  getConnection,
  listConnections,
  permissionScopes,
  resolvePublicOrigin,
  ServicePackageSchema,
  startConnection,
} from "../../../credentials/index.ts";
import type { Db } from "../../../db/client.ts";
import { logger } from "../../../logging/index.ts";
import { BadRequestError, ConflictError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import {
  cockpitReturn,
  requestLocale,
  resultResponse,
  signedInPage,
  signInFailedPage,
} from "../connectors/signin-result.ts";

const ConnectionUserSchema = z
  .object({
    connector_id: z.string(),
    slug: z.string(),
    display_name: z.string(),
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
    connectable: z.boolean(),
    reason: z.string().nullable(),
    service_name: z.string().nullable(),
    service_description: z.string().nullable(),
    service_version: z.string().nullable(),
    package_url: z.string().nullable(),
    package: ServicePackageSchema.nullable(),
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
    state: z.string().optional(),
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
  request: { query: CallbackQuery },
  responses: {
    200: {
      description: "Connected, and no single connector page to return to (HTML)",
      content: { "text/html": { schema: z.string() } },
    },
    303: { description: "Back to the connector page that uses this connection" },
    400: {
      description: "Not connected, and no single connector page to return to (HTML)",
      content: { "text/html": { schema: z.string() } },
    },
  },
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

const CONNECTION_SIGN_IN_FAILURE: Partial<Record<ConnectionFailureCode, SignInFailure>> = {
  state_invalid: "link_expired",
  denied: "provider_declined",
  token_exchange_failed: "exchange_failed",
  not_found: "connector_gone",
};

function signInFailureOf(code: ConnectionFailureCode): SignInFailure {
  return CONNECTION_SIGN_IN_FAILURE[code] ?? "not_saved";
}

async function soleConnector(db: Db, result: CompleteConnectionResult): Promise<string | null> {
  if (!result.tenant_id || !result.connection_id) return null;
  const users = await connectorsUsingConnection(db, result.tenant_id, result.connection_id);
  return users.length === 1 ? (users[0] ?? null) : null;
}

export function registerConnectionRoutes(app: OpenAPIHono<AppEnv>): void {
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
      const result = await discoverService(base_url, {
        tenant_id: requireAuth(c).tenant_id,
        exec: c.get("db"),
      });
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
          package_url: result.descriptor?.package_url ?? null,
          package: result.package,
          issuer: metadata?.issuer ?? null,
          scopes_supported: permissionScopes(metadata?.scopes_supported ?? []),
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
        actor: actorOf(principal),
        owner_user_id: principal.kind === "user" ? principal.id : null,
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
    const db = c.get("db");
    const origin = resolvePublicOrigin({ req: c.req.raw }) ?? new URL(c.req.url).origin;
    if (!query.state)
      return resultResponse(c, signInFailedPage(requestLocale(c), null, "link_expired"));
    const result = await completeConnection(db, {
      state: query.state,
      code: query.code,
      error: query.error,
    });
    if (!result.ok)
      logger.warn({
        module: "connections",
        action: "connection.callback_failed",
        msg: "a connection round did not complete",
        code: result.code,
        name: result.name,
      });
    const connectorId = await soleConnector(db, result);
    const outcome = result.ok
      ? ({ kind: "signed_in" } as const)
      : ({ kind: "signin_failed", failure: signInFailureOf(result.code) } as const);
    const back = connectorId
      ? cockpitReturn({ connector_id: connectorId, redirect_uri: origin }, outcome)
      : null;
    if (back) return back;
    return resultResponse(
      c,
      result.ok
        ? signedInPage(
            requestLocale(c),
            "cockpit",
            { stored: "signed_in", name: result.name, enabled: true, missing_scopes: [] },
            null,
          )
        : signInFailedPage(requestLocale(c), null, signInFailureOf(result.code)),
    );
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
        actor: actorOf(principal),
        owner_user_id: principal.kind === "user" ? principal.id : null,
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
        actor: actorOf(principal),
      });
    } catch (error) {
      rethrow(error);
    }
    return c.body(null, 204);
  });
}
