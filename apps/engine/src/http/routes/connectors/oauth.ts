// OAuth2 authorization-code flow.
//
//   POST /v1/connectors/{id}/oauth/start    — authenticated. Issues the
//                                             authorization URL + state.
//                                             redirect_uri is synthesized
//                                             server-side; the operator
//                                             never sees a per-connector
//                                             callback path.
//
//   GET  /v1/oauth/callback                 — UNAUTHENTICATED. The OAuth
//                                             provider redirects here with
//                                             `?code=…&state=…`. The state
//                                             row carries tenant_id +
//                                             connector_id, so the engine
//                                             routes the credential write
//                                             to the right tenant without
//                                             requiring an API key in the
//                                             user's browser session.
//
// Single global callback URL = operators add one entry to their OAuth
// provider's allowlist (e.g. `https://subkit-api.mikebild.dev/v1/oauth/callback`)
// and reuse it across every OAuth2 connector. Mirrors the reference
// impl pattern (web/src/app/api/auth/callback/route.ts) where the
// callback is connector-agnostic and `state` decodes back to the
// system_id.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, gt } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import * as connectorSvc from "../../../connectors/index.ts";
import * as credsvc from "../../../credentials/index.ts";
import { completeAuthorizationCode, startAuthorizationCode } from "../../../credentials/index.ts";
import { buildOAuthRedirectUri } from "../../../credentials/oauth2/redirect-uri.ts";
import { connectorOauthStates } from "../../../db/schema/index.ts";
import { now } from "../../../utils/clock.ts";
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
  path: "/v1/oauth/callback",
  tags: ["connectors"],
  summary: "Complete an OAuth2 authorization-code flow",
  // Unauthenticated: the OAuth provider redirects the user's browser
  // here with no API key. Authentication is by way of the opaque
  // single-use `state` token, which the engine generated and stored
  // in connector_oauth_states with the (tenant_id, connector_id) pair.
  request: { query: OAuthCallbackQuery },
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
    const redirect_uri = buildOAuthRedirectUri(c.req.raw);
    if (!redirect_uri) {
      throw new BadRequestError(
        "engine has no resolvable public origin — set server.public_base_url or SUBKIT_PUBLIC_BASE_URL",
      );
    }
    const cfgWithRedirect = { ...cfg, redirect_uri };
    const started = await startAuthorizationCode(cfgWithRedirect);
    await db.insert(connectorOauthStates).values({
      tenant_id: principal.tenant_id,
      connector_id: id,
      state: started.state,
      code_verifier: started.code_verifier,
      redirect_uri,
      expires_at: new Date(Date.now() + 10 * 60_000),
    });
    return c.json({ authorization_url: started.authorization_url, state: started.state }, 200);
  });

  app.openapi(oauthCallbackRoute, async (c) => {
    const db = c.get("db");
    const q = c.req.valid("query");
    const stateRows = await db
      .select()
      .from(connectorOauthStates)
      .where(
        and(
          eq(connectorOauthStates.state, q.state),
          gt(connectorOauthStates.expires_at, new Date(now())),
        ),
      )
      .limit(1);
    const stateRow = stateRows[0];
    if (!stateRow) throw new BadRequestError("oauth state not found or expired");
    const connector = await connectorSvc.getConnector(
      stateRow.tenant_id,
      stateRow.connector_id,
      db,
    );
    if (!connector) throw new NotFoundError("connector");
    const cfg = await connectorOauthCfg(db, stateRow.tenant_id, connector);
    const cfgWithRedirect = { ...cfg, redirect_uri: stateRow.redirect_uri };
    const current = new URL(stateRow.redirect_uri);
    current.searchParams.set("code", q.code);
    current.searchParams.set("state", q.state);
    const bundle = await completeAuthorizationCode({
      cfg: cfgWithRedirect,
      current_url: current,
      code_verifier: stateRow.code_verifier,
      state: stateRow.state,
    });
    await credsvc.upsertCredential(
      {
        tenant_id: stateRow.tenant_id,
        connector_id: stateRow.connector_id,
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
        // Anonymous browser hit — no operator principal. The state-row
        // tenant scope is the auth proof; pass null so the credential
        // service falls back to its `oauth_callback` actor label.
        actor_id: null,
      },
      db,
    );
    await db.delete(connectorOauthStates).where(eq(connectorOauthStates.id, stateRow.id));
    return c.json({ ok: true }, 200);
  });
}
