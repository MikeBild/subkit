// Connectors HTTP surface — entry point.
//
// The former http/routes/connectors.ts split into per-sub-resource
// modules; this barrel registers shared per-path RBAC middleware and
// delegates handler registration to each module. Public API
// unchanged: server.ts still calls `registerConnectorRoutes(app)`.
//
//   GET    /v1/connectors                          — list (optional ?environment=)
//   POST   /v1/connectors                          — create
//   GET    /v1/connectors/:id                      — fetch
//   PATCH  /v1/connectors/:id                      — update
//   DELETE /v1/connectors/:id                      — soft delete
//   POST   /v1/connectors/:id/test                 — driver health probe
//   POST   /v1/connectors/:id/call                 — ad-hoc HTTP/GraphQL call
//   POST   /v1/connectors/:id/oauth/start          — returns authorization_url + state
//   GET    /v1/oauth/callback                      — completes code exchange (single
//                                                    global endpoint; routes by state)
//   POST   /v1/connectors/:id/credentials          — attach non-oauth credential (API key)
//   GET    /v1/connectors/:id/credentials/setup     — browser-openable credential-setup
//                                                    form (single-use grant token)
//   POST   /v1/connectors/:id/credentials/setup     — submits the form above (grant token)
//   POST   /v1/connectors/:id/end-user-credentials — end-user-scoped credential

import type { OpenAPIHono } from "@hono/zod-openapi";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { registerCallRoutes } from "./call.ts";
import { registerCollectionRoutes } from "./collection.ts";
import { registerCredentialsRoutes } from "./credentials.ts";
import { registerCredentialsSetupRoutes } from "./credentials-setup.ts";
import { registerOAuthRoutes } from "./oauth.ts";
import { registerTestRoutes } from "./test.ts";

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
    // POST: authenticated bearer-token path — requires connector:oauth permission.
    // GET:  grant-token path — unauthenticated (single-use skog_… token in query);
    //       authentication is enforced inside the route handler by consumeStartGrant.
    if (c.req.method === "POST") {
      const id = c.req.param("id");
      return requirePermission("connector:oauth", () => ({ type: "connector", id }))(c, next);
    }
    return next();
  });
  // GET /v1/oauth/callback is deliberately NOT gated by requirePermission:
  // the OAuth provider redirects the user's browser here with no API
  // key. Authentication is by way of the single-use `state` query
  // parameter, which the engine generated and persisted with the
  // (tenant_id, connector_id) pair in connector_oauth_states.
  app.use("/v1/connectors/:id/credentials", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("credential:write", () => ({ type: "connector", id }))(c, next);
  });
  // GET/POST /v1/connectors/:id/credentials/setup are deliberately NOT
  // gated by requirePermission — both are unauthenticated, grant-token-authed
  // browser routes (single-use sksg_… token in the query string / hidden form
  // field). Authentication is enforced inside the route handlers by
  // validateSetupGrant (GET) and consumeSetupGrant (POST). Same discipline as
  // the GET /v1/connectors/:id/oauth/start exemption above.
  app.use("/v1/connectors/:id/credentials/setup", async (_c, next) => next());
  app.use("/v1/connectors/:id/end-user-credentials", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("credential:write", () => ({ type: "connector", id }))(c, next);
  });

  registerCollectionRoutes(app);
  registerTestRoutes(app);
  registerCallRoutes(app);
  registerOAuthRoutes(app);
  registerCredentialsRoutes(app);
  registerCredentialsSetupRoutes(app);
}
