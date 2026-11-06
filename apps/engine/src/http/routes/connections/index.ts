import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  deleteConnectionOperation,
  discoverConnectionOperation,
  getConnectionOperation,
  listConnectionsOperation,
  renewConnectionOperation,
  startConnectionOperation,
} from "../../../api/operations/connection.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import type { SignInFailure } from "../../../connectors/index.ts";
import {
  type CompleteConnectionResult,
  type ConnectionFailureCode,
  completeConnection,
  connectorsUsingConnection,
  resolvePublicOrigin,
} from "../../../credentials/index.ts";
import type { Db } from "../../../db/client.ts";
import { logger } from "../../../logging/index.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import {
  cockpitReturn,
  requestLocale,
  resultResponse,
  signedInPage,
  signInFailedPage,
} from "../connectors/signin-result.ts";

const CallbackQuery = z
  .object({
    state: z.string().optional(),
    code: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .openapi("ConnectionCallbackQuery");

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
    c.req.method === "GET" ? next() : requirePermission("connection:write")(c, next),
  );
  app.use("/v1/connections/discover", (c, next) =>
    c.req.method === "POST" ? next() : requirePermission("connection:write")(c, next),
  );
  app.use("/v1/connections/start", (c, next) =>
    c.req.method === "POST" ? next() : requirePermission("connection:write")(c, next),
  );
  app.use("/v1/connections/:id", (c, next) => {
    if (c.req.param("id") === "callback") return next();
    return c.req.method === "GET" || c.req.method === "DELETE"
      ? next()
      : requirePermission("connection:write")(c, next);
  });
  app.use("/v1/connections/:id/renew", (c, next) =>
    c.req.method === "POST" ? next() : requirePermission("connection:write")(c, next),
  );

  toHonoRoute(app, discoverConnectionOperation);
  toHonoRoute(app, startConnectionOperation);

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

  toHonoRoute(app, listConnectionsOperation);
  toHonoRoute(app, getConnectionOperation);
  toHonoRoute(app, renewConnectionOperation);
  toHonoRoute(app, deleteConnectionOperation);
}
