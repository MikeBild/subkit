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
import { logger } from "../logging/logger.ts";
import { registerMcpHttpRoutes } from "../mcp/transports/streamable-http.ts";
import { errorRing } from "../observability/error-ring.ts";
import { metricsMiddleware } from "../observability/middleware.ts";
import { authMiddleware } from "./middleware/auth.ts";
import { errorMiddleware, mapKnownErrorResponse } from "./middleware/error.ts";
import { loggingMiddleware } from "./middleware/logging.ts";
import { rateLimitMiddleware } from "./middleware/rate-limit.ts";
import { traceMiddleware } from "./middleware/trace.ts";
import { type AppEnv, createOpenApiApp, OPENAPI_INFO, SECURITY_SCHEMES } from "./openapi.ts";
import { registerAiExtractRoute } from "./routes/ai/extract.ts";
import { registerAiGenerateRoute } from "./routes/ai/generate.ts";
import { registerAiRepairRoute } from "./routes/ai/repair.ts";
import { registerAiSummarizeRoute } from "./routes/ai/summarize.ts";
import { registerAuditLogRoutes } from "./routes/audit-log.ts";
import { registerChatRoutes } from "./routes/chat.ts";
import { registerConnectorDiscoveryRoutes } from "./routes/connector-discovery.ts";
import { registerConnectorDocsRoutes } from "./routes/connector-docs.ts";
import { registerConnectorTemplateRoutes } from "./routes/connector-templates.ts";
import { registerConnectorRoutes } from "./routes/connectors.ts";
import { registerConversationAttachmentRoutes } from "./routes/conversation-attachments.ts";
import { registerConversationRoutes } from "./routes/conversations/index.ts";
import { registerCredentialRoutes } from "./routes/credentials.ts";
import { registerDiagnosticsRoutes } from "./routes/diagnostics.ts";
import { registerDiscoveryRoutes } from "./routes/discovery.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerExecutionRoutes } from "./routes/executions/index.ts";
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
import { registerInstallRoute } from "./routes/install.ts";
import { registerKnowledgeSourceRoutes } from "./routes/knowledge-sources.ts";
import { registerMcpCatalogRoutes } from "./routes/mcp-catalog.ts";
import { registerMetricsRoute } from "./routes/metrics.ts";
import { registerNotificationRoutes } from "./routes/notifications/index.ts";
import { registerPatchCandidateRoutes } from "./routes/patch-candidates.ts";
import { registerRbacRoutes } from "./routes/rbac.ts";
import { registerRequestHookRoutes } from "./routes/request-hooks.ts";
import { registerSettingsRoutes } from "./routes/settings.ts";
import { registerSetupRoute } from "./routes/setup.ts";
import { registerSkillCandidateRoutes } from "./routes/skill-candidates.ts";
import { registerSkillRoutes } from "./routes/skills.ts";
import { registerStatusRoute } from "./routes/status.ts";
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

  // Hono's default onError resolves before middleware catch blocks see
  // the exception, so map known envelopes here too. Note: onError MUST
  // return a Response.
  app.onError((err, c) => {
    const traceId = c.get("trace_id") ?? null;
    const principal = c.get("principal") as { tenant_id?: string } | undefined;
    const path = new URL(c.req.url).pathname;
    const knownResponse = mapKnownErrorResponse(c, err);
    if (knownResponse) return knownResponse;
    // Unhandled / non-HttpError. Log the full diagnostic AND write the
    // error ring — the middleware's catch never sees this path because
    // Hono's router resolves the onError handler first. Without the
    // ring write, the 500 is invisible to /v1/diagnostics/errors which
    // is exactly where operators look.
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? null) : null;
    logger.error({
      module: "http",
      action: "request.failed",
      msg: "unhandled error",
      method: c.req.method,
      path: c.req.path,
      error: message,
      stack: stack ?? undefined,
      trace_id: traceId,
    });
    errorRing.record({
      trace_id: traceId,
      ts: new Date().toISOString(),
      tenant_id: principal?.tenant_id ?? null,
      method: c.req.method,
      path,
      status: 500,
      code: "internal_error",
      message,
      stack,
      bucket: "unhandled",
    });
    return c.json(
      {
        code: "internal_error",
        message: "internal error",
        trace_id: traceId,
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

  registerHealthRoute(app, opts.db ? { db: opts.db } : {});
  registerInstallRoute(app);
  registerSetupRoute(app);
  registerStatusRoute(app);
  registerSettingsRoutes(app);
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
  registerConnectorDiscoveryRoutes(app);
  registerConnectorDocsRoutes(app);
  registerCredentialRoutes(app);
  registerSkillRoutes(app);
  registerKnowledgeSourceRoutes(app);
  registerSkillCandidateRoutes(app);
  registerDiscoveryRoutes(app);
  registerConversationRoutes(app);
  registerConversationAttachmentRoutes(app);
  registerMcpCatalogRoutes(app);
  registerAiGenerateRoute(app);
  registerAiExtractRoute(app);
  registerAiRepairRoute(app);
  registerAiSummarizeRoute(app);
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
  registerDiagnosticsRoutes(app);
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
