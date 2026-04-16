// Hono app factory. Wires:
//   - trace + logging + auth + error middleware
//   - /v1/health
//   - /v1/identity/* routes
//   - /openapi.json
//   - /docs (Scalar)
//
// Tests construct an app via `createApp({ db, registry })` so they can swap
// in a per-test database and registry without touching env globals.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { createApiKeyProvider } from "../auth/providers/api-key.ts";
import { createOidcProvider } from "../auth/providers/oidc.ts";
import { createPortalTokenProvider } from "../auth/providers/portal-token.ts";
import { AuthProviderRegistry } from "../auth/registry.ts";
import { ChatAdapterRegistry } from "../chat/registry.ts";
import type { Db } from "../db/client.ts";
import { registerMcpHttpRoutes } from "../mcp/transports/streamable-http.ts";
import { metricsMiddleware } from "../observability/middleware.ts";
import { HttpError } from "./errors.ts";
import { authMiddleware } from "./middleware/auth.ts";
import { errorMiddleware } from "./middleware/error.ts";
import { loggingMiddleware } from "./middleware/logging.ts";
import { portalTokenWorkflowGuard } from "./middleware/policy.ts";
import { rateLimitMiddleware } from "./middleware/rate-limit.ts";
import { traceMiddleware } from "./middleware/trace.ts";
import { type AppEnv, createOpenApiApp, OPENAPI_INFO, SECURITY_SCHEMES } from "./openapi.ts";
import { registerAiExtractRoute } from "./routes/ai/extract.ts";
import { registerAiGenerateRoute } from "./routes/ai/generate.ts";
import { registerAiRepairRoute } from "./routes/ai/repair.ts";
import { registerAuditLogRoutes } from "./routes/audit-log.ts";
import { registerChatRoutes } from "./routes/chat.ts";
import { registerConnectorDocsRoutes } from "./routes/connector-docs.ts";
import { registerConnectorTemplateRoutes } from "./routes/connector-templates.ts";
import { registerConnectorRoutes } from "./routes/connectors.ts";
import { registerConversationRoutes } from "./routes/conversations.ts";
import { registerCredentialRoutes } from "./routes/credentials.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerExecutionRoutes } from "./routes/executions.ts";
import { registerHealthRoute } from "./routes/health.ts";
import { registerHooksInboundRoutes } from "./routes/hooks-inbound.ts";
import { registerApiKeyRoutes } from "./routes/identity/api-keys.ts";
import { registerLoginRoutes } from "./routes/identity/login.ts";
import { registerPortalTokenRoutes } from "./routes/identity/portal-tokens.ts";
import { registerProvidersRoute } from "./routes/identity/providers.ts";
import { registerSessionsOidcRoute } from "./routes/identity/sessions-oidc.ts";
import { registerSystemAccountRoutes } from "./routes/identity/system-accounts.ts";
import { registerTenantRoutes } from "./routes/identity/tenants.ts";
import { registerUserRoutes } from "./routes/identity/users.ts";
import { registerWhoamiRoute } from "./routes/identity/whoami.ts";
import { registerMcpCatalogRoutes } from "./routes/mcp-catalog.ts";
import { registerMetricsRoute } from "./routes/metrics.ts";
import { registerNotificationRoutes } from "./routes/notifications.ts";
import { registerPatchCandidateRoutes } from "./routes/patch-candidates.ts";
import { registerRbacRoutes } from "./routes/rbac.ts";
import { registerRequestHookRoutes } from "./routes/request-hooks.ts";
import { registerKnowledgeSourceRoutes } from "./routes/knowledge-sources.ts";
import { registerSkillCandidateRoutes } from "./routes/skill-candidates.ts";
import { registerSkillRoutes } from "./routes/skills.ts";
import { registerSubscriptionRoutes } from "./routes/subscriptions.ts";
import { registerTunnelRoutes } from "./routes/tunnels.ts";
import { registerWorkflowRoutes } from "./routes/workflows.ts";

export interface CreateAppOptions {
  db?: Db;
  registry?: AuthProviderRegistry;
  chatRegistry?: ChatAdapterRegistry;
}

export function buildDefaultRegistry(db?: Db): AuthProviderRegistry {
  const reg = new AuthProviderRegistry();
  // Portal tokens are registered first so `wf_portal_*` bearers resolve
  // before the api-key provider even runs its prefix lookup. Both
  // providers reject foreign prefixes fast, so ordering is a
  // performance/logging preference rather than a correctness
  // requirement.
  reg.register(createPortalTokenProvider(db ? { db } : {}));
  reg.register(createApiKeyProvider(db ? { db } : {}));
  reg.register(createOidcProvider());
  return reg;
}

const SCALAR_HTML = `<!doctype html>
<html>
  <head>
    <title>subkit engine — API reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;

export function createApp(opts: CreateAppOptions = {}): OpenAPIHono<AppEnv> {
  const app = createOpenApiApp();
  const registry = opts.registry ?? buildDefaultRegistry(opts.db);

  // Order matters: trace -> logging -> rate-limit -> metrics -> error wrap -> db -> auth -> routes.
  app.use("*", traceMiddleware());
  app.use("*", loggingMiddleware());
  app.use("*", rateLimitMiddleware());
  app.use("*", metricsMiddleware());
  app.use("*", errorMiddleware());

  // Hono's default onError swallows exceptions before middleware catch
  // blocks see them, so we install an onError that rethrows so
  // errorMiddleware can map cleanly. Note: onError MUST return a Response.
  app.onError((err, c) => {
    // Re-route through the same envelope shape used by errorMiddleware.
    if (err instanceof HttpError) {
      return c.json(
        {
          code: err.code,
          message: err.message,
          trace_id: c.get("trace_id"),
          ...(err.details ? { details: err.details } : {}),
        },
        err.status as 400 | 401 | 403 | 404 | 409 | 413 | 415 | 500,
      );
    }
    return c.json(
      {
        code: "internal_error",
        message: "internal error",
        trace_id: c.get("trace_id"),
      },
      500,
    );
  });
  if (opts.db) {
    const boundDb = opts.db;
    app.use("*", async (c, next) => {
      c.set("db", boundDb);
      await next();
    });
  } else {
    // Lazy bind to the shared pool.
    app.use("*", async (c, next) => {
      const { getDb } = await import("../db/client.ts");
      c.set("db", getDb());
      await next();
    });
  }
  app.use("*", authMiddleware(registry));
  // Portal-token allowlist gate for `POST /v1/workflows/:id/run`. No-op
  // for every other route and every non-enduser principal.
  app.use("*", portalTokenWorkflowGuard());

  registerHealthRoute(app, opts.db ? { db: opts.db } : {});
  registerMetricsRoute(app);
  registerTenantRoutes(app);
  registerUserRoutes(app);
  registerSystemAccountRoutes(app);
  registerApiKeyRoutes(app);
  registerPortalTokenRoutes(app);
  registerProvidersRoute(app);
  registerSessionsOidcRoute(app);
  registerLoginRoutes(app);
  registerWhoamiRoute(app);
  registerWorkflowRoutes(app);
  registerExecutionRoutes(app);
  registerConnectorTemplateRoutes(app);
  registerConnectorRoutes(app);
  registerConnectorDocsRoutes(app);
  registerCredentialRoutes(app);
  registerSkillRoutes(app);
  registerKnowledgeSourceRoutes(app);
  registerSkillCandidateRoutes(app);
  registerConversationRoutes(app);
  registerMcpCatalogRoutes(app);
  registerAiGenerateRoute(app);
  registerAiExtractRoute(app);
  registerAiRepairRoute(app);
  registerPatchCandidateRoutes(app);
  registerHooksInboundRoutes(app);
  registerRequestHookRoutes(app);
  registerChatRoutes(app, { registry: opts.chatRegistry ?? new ChatAdapterRegistry() });
  registerSubscriptionRoutes(app);
  registerNotificationRoutes(app);
  registerEventRoutes(app);
  registerTunnelRoutes(app);
  registerRbacRoutes(app);
  registerAuditLogRoutes(app);
  registerMcpHttpRoutes(app);

  // OpenAPI document
  app.doc("/openapi.json", {
    openapi: "3.0.0",
    info: OPENAPI_INFO,
  });

  // Inject security schemes manually because @hono/zod-openapi's `doc()`
  // does not accept a `components` block in this version.
  app.openAPIRegistry.registerComponent(
    "securitySchemes",
    "bearerAuth",
    SECURITY_SCHEMES.bearerAuth,
  );

  // Scalar UI
  app.get("/docs", (c) => c.html(SCALAR_HTML));

  return app;
}
