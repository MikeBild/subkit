// Connectors HTTP surface — entry point.
//
// The former http/routes/connectors.ts split into per-sub-resource
// modules; this barrel registers shared per-path RBAC middleware and
// delegates handler registration to each module. Public API
// unchanged: server.ts still calls `registerConnectorRoutes(app)`.
//
//   GET    /v1/connectors                          — list (optional ?environment=)
//   POST   /v1/connectors                          — create
//   POST   /v1/connectors/validate                 — check a definition, save nothing
//   POST   /v1/connectors/probe                    — probe a definition, save nothing
//   POST   /v1/connectors/import                   — spec → draft definition, save nothing
//   GET    /v1/connectors/:id                      — fetch
//   PATCH  /v1/connectors/:id                      — update
//   DELETE /v1/connectors/:id                      — soft delete
//   POST   /v1/connectors/:id/enable               — operator on switch
//   POST   /v1/connectors/:id/disable              — operator off switch
//   POST   /v1/connectors/:id/test                 — driver health probe
//   POST   /v1/connectors/:id/mcp/inspect          — mcp driver: handshake + manifest
//   POST   /v1/connectors/:id/mcp/authorize        — mcp driver: begin OAuth 2.1
//   GET    /v1/connectors/mcp/oauth/callback       — mcp driver: complete OAuth 2.1
//                                                    (unauthenticated; state-token)
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
import { registerAuthoringRoutes } from "./authoring.ts";
import { registerCallRoutes } from "./call.ts";
import { registerCollectionRoutes } from "./collection.ts";
import { registerCredentialsRoutes } from "./credentials.ts";
import { registerCredentialsSetupRoutes } from "./credentials-setup.ts";
import { registerConnectorMcpRoutes } from "./mcp.ts";
import { registerOAuthRoutes } from "./oauth.ts";
import { registerPromotionRoutes } from "./promotion.ts";
import { registerTestRoutes } from "./test.ts";

/** Fixed segments under `/v1/connectors` that are routes, not connector ids.
 *  Kept next to the middleware that has to know the difference. */
const RESERVED_CONNECTOR_SEGMENTS = new Set(["validate", "probe", "import", "mcp"]);

export function registerConnectorRoutes(app: OpenAPIHono<AppEnv>): void {
  // Pass-2 C5: RBAC gating for every connector + credential surface.
  // Collection routes get a method-switched middleware; resource routes
  // pass a resource descriptor so the evaluator can consult grants.
  app.use("/v1/connectors", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("connector:read")(c, next);
    if (c.req.method === "POST") return requirePermission("connector:write")(c, next);
    return next();
  });
  // The authoring trio sits on fixed segments under /v1/connectors. They must
  // be gated BEFORE the `:id` matcher below, which would otherwise treat
  // "validate"/"probe"/"import" as a connector id.
  //
  // `connector:write` for validate and import — both are steps of the authoring
  // flow whose only outcome is a definition the caller then saves. `probe`
  // takes `connector:test`, the same grant the saved-connector probe takes:
  // it makes a real outbound request with caller-supplied credentials.
  app.use("/v1/connectors/validate", requirePermission("connector:write"));
  app.use("/v1/connectors/import", requirePermission("connector:write"));
  app.use("/v1/connectors/probe", requirePermission("connector:test"));
  app.use("/v1/connectors/:id", async (c, next) => {
    const id = c.req.param("id");
    // Guard against a future route landing on a fixed segment without its own
    // gate above: a reserved word is never a connector id.
    if (RESERVED_CONNECTOR_SEGMENTS.has(id)) return next();
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
  // Enable/disable are configuration writes, not invocations: they take
  // the same grant as PATCH.
  for (const segment of ["enable", "disable"] as const) {
    app.use(`/v1/connectors/:id/${segment}`, async (c, next) => {
      const id = c.req.param("id");
      return requirePermission("connector:write", () => ({ type: "connector", id }))(c, next);
    });
  }
  // The mcp driver's two authenticated routes. `inspect` forces a real
  // outbound handshake, which is what `connector:test` gates everywhere
  // else; `authorize` begins an OAuth dance, which is `connector:oauth`.
  // GET /v1/connectors/mcp/oauth/callback is deliberately absent from this
  // list — the authorization server redirects a browser there with no API
  // key, and the single-use `state` row is the authentication.
  app.use("/v1/connectors/:id/mcp/inspect", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("connector:test", () => ({ type: "connector", id }))(c, next);
  });
  app.use("/v1/connectors/:id/mcp/authorize", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("connector:oauth", () => ({ type: "connector", id }))(c, next);
  });
  app.use("/v1/connectors/:id/test", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("connector:test", () => ({ type: "connector", id }))(c, next);
  });
  app.use("/v1/connectors/:id/promote", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("connector:promote", () => ({ type: "connector", id }))(c, next);
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

  registerAuthoringRoutes(app);
  registerCollectionRoutes(app);
  registerTestRoutes(app);
  registerPromotionRoutes(app);
  registerCallRoutes(app);
  registerOAuthRoutes(app);
  registerCredentialsRoutes(app);
  registerCredentialsSetupRoutes(app);
  registerConnectorMcpRoutes(app);
}
