// OAuth2 authorization-code flow for a connector:
//   POST /v1/connectors/{id}/oauth/start
//   GET  /v1/connectors/{id}/oauth/callback

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import * as connectorSvc from "../../../connectors/service.ts";
import {
  completeAuthorizationCode,
  startAuthorizationCode,
} from "../../../credentials/oauth2/client.ts";
import type { OAuth2ClientConfig } from "../../../credentials/oauth2/types.ts";
import * as credsvc from "../../../credentials/service.ts";
import { connectorOauthStates } from "../../../db/schema/index.ts";
import { BadRequestError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { connectorOauthCfg, OAuthCallbackQuery, OAuthStartResponse } from "./schemas.ts";

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

export function registerOAuthRoutes(app: OpenAPIHono<AppEnv>): void {
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
}
