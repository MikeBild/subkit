// Hono app factory. Wires:
//   - trace + logging + auth + error middleware
//   - /health
//   - /v1/identity/* routes
//   - /openapi.json
//   - /docs (Scalar)
//   - /llms.txt + /llms-full.txt (llms-txt docs for LLM clients)
//
// Tests construct an app via `createApp({ db, registry })` so they can swap
// in a per-test database and registry without touching env globals.

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { PgBoss } from "pg-boss";
import { createApiKeyProvider } from "../auth/providers/api-key.ts";
import { createBrowserSessionProvider } from "../auth/providers/browser-session.ts";
import { createMcpOAuthAuthProvider } from "../auth/providers/mcp-oauth.ts";
import { createOidcProvider } from "../auth/providers/oidc.ts";
import { createPortalTokenProvider } from "../auth/providers/portal-token.ts";
import { AuthProviderRegistry } from "../auth/registry.ts";
import { ChatAdapterRegistry } from "../chat/registry.ts";
import { getConfig } from "../config/loader.ts";
import type { Config } from "../config/schema.ts";
import type { Db } from "../db/client.ts";
import { logger } from "../logging/logger.ts";
import { registerMcpHttpRoutes } from "../mcp/transports/streamable-http.ts";
import { errorRing } from "../observability/error-ring.ts";
import { metricsMiddleware } from "../observability/middleware.ts";
import { getBoss } from "../queue/boss.ts";
import {
  AGENT_SESSION_ANALYZE_QUEUE,
  type AgentSessionAnalyzeJob,
} from "../queue/handlers/agent-session-analyze.ts";
import { CHAT_EVENT_QUEUE, type ChatEventJob } from "../queue/queues.ts";
import { registerCockpitRoutes } from "./cockpit.ts";
import { authMiddleware } from "./middleware/auth.ts";
import { browserCsrfMiddleware } from "./middleware/browser-csrf.ts";
import { errorMiddleware, mapKnownErrorResponse } from "./middleware/error.ts";
import { loggingMiddleware } from "./middleware/logging.ts";
import { rateLimitMiddleware } from "./middleware/rate-limit.ts";
import { traceMiddleware } from "./middleware/trace.ts";
import { type AppEnv, createOpenApiApp, OPENAPI_INFO, SECURITY_SCHEMES } from "./openapi.ts";
import { registerAgentBriefingRoutes } from "./routes/agent-briefing.ts";
import { registerAgentSessionRoutes } from "./routes/agent-sessions.ts";
import { registerAiExtractRoute } from "./routes/ai/extract.ts";
import { registerAiGenerateRoute } from "./routes/ai/generate.ts";
import { registerAiRepairRoute } from "./routes/ai/repair.ts";
import { registerAiSummarizeRoute } from "./routes/ai/summarize.ts";
import { registerAuditLogRoutes } from "./routes/audit-log.ts";
import { registerChatRoutes } from "./routes/chat.ts";
import { registerChatIdentityRoutes } from "./routes/chat-identities.ts";
import { registerChatSpaceRoutes } from "./routes/chat-spaces.ts";
import { registerChatWorkspaceRoutes } from "./routes/chat-workspaces.ts";
import { registerComposeRoute } from "./routes/compose.ts";
import { registerConnectorDiscoveryRoutes } from "./routes/connector-discovery.ts";
import { registerConnectorDocsRoutes } from "./routes/connector-docs.ts";
import { registerConnectorTemplateRoutes } from "./routes/connector-templates/index.ts";
import { registerConnectorRoutes } from "./routes/connectors/index.ts";
import { registerConversationAttachmentRoutes } from "./routes/conversation-attachments.ts";
import { registerConversationRoutes } from "./routes/conversations/index.ts";
import { registerCredentialRoutes } from "./routes/credentials.ts";
import { registerDiagnosticsRoutes } from "./routes/diagnostics/index.ts";
import { registerDiscoveryRoutes } from "./routes/discovery.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerExecutionRoutes } from "./routes/executions/index.ts";
import { registerFileRoutes } from "./routes/files.ts";
import { registerHealthRoute } from "./routes/health.ts";
import { registerHooksInboundRoutes } from "./routes/hooks-inbound.ts";
import { registerApiKeyRoutes } from "./routes/identity/api-keys.ts";
import { registerCockpitIdentityRoutes } from "./routes/identity/cockpit.ts";
import { registerInviteRoutes } from "./routes/identity/invites.ts";
import { registerLoginRoutes } from "./routes/identity/login.ts";
import { registerEffectivePermissionsRoute } from "./routes/identity/permissions.ts";
import { registerPortalTokenRoutes } from "./routes/identity/portal-tokens.ts";
import { registerProvidersRoute } from "./routes/identity/providers.ts";
import { registerIdentitySessionsRoute } from "./routes/identity/sessions.ts";
import { registerSkBootstrapRoute } from "./routes/identity/sk-bootstrap.ts";
import { registerSystemAccountRoutes } from "./routes/identity/system-accounts.ts";
import { registerTenantRoutes } from "./routes/identity/tenants.ts";
import { registerUserRoutes } from "./routes/identity/users.ts";
import { registerWhoamiRoute } from "./routes/identity/whoami.ts";
import { registerInstallRoute } from "./routes/install.ts";
import { registerInstallBinaryRoute } from "./routes/install-binary.ts";
import { registerKnowledgeSourceRoutes } from "./routes/knowledge-sources.ts";
import { registerLlmsTxtRoutes } from "./routes/llms-txt.ts";
import { registerMcpCatalogRoutes } from "./routes/mcp-catalog.ts";
import { registerMetricsRoute } from "./routes/metrics.ts";
import { registerNotificationRoutes } from "./routes/notifications/index.ts";
import { registerMcpOAuthRoutes } from "./routes/oauth.ts";
import { registerOAuthClientAdminRoutes } from "./routes/oauth-clients.ts";
import { registerOperatorRoutes } from "./routes/operator/health-digest.ts";
import { registerOperationalOverviewRoute } from "./routes/operator/operational-overview.ts";
import { registerPatchCandidateRoutes } from "./routes/patch-candidates.ts";
import { registerRbacRoutes } from "./routes/rbac/index.ts";
import { registerRequestHookRoutes } from "./routes/request-hooks.ts";
import { registerRootRoute } from "./routes/root.ts";
import { registerRuntimeConfigRoutes } from "./routes/runtime-config.ts";
import { registerSelfHealingRoutes } from "./routes/self-healing.ts";
import { registerSettingsRoutes } from "./routes/settings.ts";
import { registerSetupRoute } from "./routes/setup.ts";
import { registerSkillCandidateRoutes } from "./routes/skill-candidates.ts";
import { registerSkillRoutes } from "./routes/skills.ts";
import { registerStatsRoutes } from "./routes/stats/index.ts";
import { registerStatusRoute } from "./routes/status.ts";
import { registerSubscriptionRoutes } from "./routes/subscriptions.ts";
import { registerToolApprovalRoutes } from "./routes/tool-approvals.ts";
import { registerWorkflowRoutes } from "./routes/workflows.ts";

export interface CreateAppOptions {
  db?: Db;
  /** Bind a queue runtime to this app. Disposable test apps must inject
   * their own instance so parallel databases cannot share the global boss. */
  boss?: PgBoss;
  registry?: AuthProviderRegistry;
  chatRegistry?: ChatAdapterRegistry;
  /** Override for the chat-route enqueue callback. Default forwards to
   *  pg-boss via `getBoss().send(CHAT_EVENT_QUEUE, …)`, mirroring the
   *  hooks-inbound pattern. Tests that exercise the chat HTTP surface
   *  without running a real boss can pass a stub here. */
  chatEnqueue?: (job: ChatEventJob) => Promise<void>;
  /** Override for the agent-session capture enqueue callback. Same
   *  lazy-boss rationale as `chatEnqueue`; tests inject a stub. */
  agentSessionEnqueue?: (job: AgentSessionAnalyzeJob) => Promise<void>;
  /** Override the in-memory rate limiter (default 100 req / 60s). Used
   *  by the http test scaffold to bump the ceiling so per-leaf sweep
   *  tests fit under the budget even as the schema grows. */
  rateLimit?: { max?: number; windowMs?: number };
}

export function buildDefaultRegistry(db?: Db, cfg?: Config["auth"]): AuthProviderRegistry {
  const reg = new AuthProviderRegistry();

  // The set of registered providers is config-driven. When the config
  // loader has not been initialised (some unit/test paths build an app
  // before boot), fall back to the always-on local providers so the
  // engine never starts with an empty registry.
  let auth = cfg;
  if (!auth) {
    try {
      auth = getConfig().auth;
    } catch {
      /* loader not initialised — fall through to local defaults below */
    }
  }
  const enableMcpOAuth = auth?.mcp_oauth.enabled ?? true;
  const providerConfigs = auth?.providers ?? [
    { protocol: "api_key" as const, id: "api-key", label: "SubKit API key" },
  ];

  const registered: string[] = [];

  // Registration order is a latency optimisation, not a correctness
  // requirement: the registry returns the first non-null principal and each
  // prefix-bound provider rejects foreign tokens before touching the DB. The
  // unambiguous-prefix machine providers come first; the JWT/cookie human
  // provider (if any) follows.
  if (enableMcpOAuth) {
    reg.register(createMcpOAuthAuthProvider(db ? { db } : {}));
    registered.push("mcp_oauth");
  }
  reg.register(createPortalTokenProvider(db ? { db } : {}));
  registered.push("portal_token");
  reg.register(createApiKeyProvider(db ? { db } : {}));
  registered.push("api_key");
  for (const provider of providerConfigs) {
    if (provider.protocol === "oidc") {
      reg.register(
        createOidcProvider({
          providerId: provider.id,
          issuerUrl: provider.issuer_url,
          clientId: provider.client_id,
          scopes: provider.scopes,
          tenantSlug: provider.tenant_slug,
          ...(db ? { db } : {}),
        }),
      );
      registered.push(provider.id);
    }
  }

  // The `subkit_session` cookie, LAST: it only reads a cookie, so it costs a
  // token-bearing request nothing and can never shadow one.
  //
  // Unconditional on purpose. The login funnel mints this cookie on every path
  // (API-key paste form and OIDC callback alike), but the only resolver used to
  // live inside the OIDC provider — so on the default api_key-only config the
  // middleware ignored it and a freshly logged-in human was anonymous to every
  // route. That is what made the approval portal record `granted_by_user_id:
  // NULL` for every grant.
  reg.register(createBrowserSessionProvider(db ? { db } : {}));
  registered.push("browser_session");

  logger.info({
    module: "auth",
    action: "registry.built",
    msg: "auth provider registry built",
    providers: registered,
  });

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

  // Order matters: trace -> logging -> metrics -> error wrap -> db -> auth -> anonymous
  // rate-limit -> routes. The limiter must see the resolved principal so authenticated
  // cockpit/API reads do not consume the shared anonymous per-IP budget.
  app.use("*", traceMiddleware());
  app.use("*", loggingMiddleware());
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
  if (opts.boss) {
    const boundBoss = opts.boss;
    app.use("*", async (c, next) => {
      c.set("boss", boundBoss);
      await next();
    });
  }
  app.use("*", authMiddleware(registry));
  app.use("*", rateLimitMiddleware(opts.rateLimit ?? {}));
  app.use("/v1/*", browserCsrfMiddleware());

  registerHealthRoute(app, opts.db ? { db: opts.db } : {});
  registerInstallRoute(app);
  registerInstallBinaryRoute(app);
  registerSetupRoute(app);
  registerStatusRoute(app);
  registerStatsRoutes(app);
  registerRuntimeConfigRoutes(app);
  registerSettingsRoutes(app);
  registerMetricsRoute(app);
  registerLlmsTxtRoutes(app);
  registerComposeRoute(app);
  registerRootRoute(app);
  registerTenantRoutes(app);
  registerUserRoutes(app);
  registerInviteRoutes(app);
  registerSystemAccountRoutes(app);
  registerApiKeyRoutes(app);
  registerPortalTokenRoutes(app);
  registerProvidersRoute(app);
  registerIdentitySessionsRoute(app);
  registerLoginRoutes(app);
  registerCockpitIdentityRoutes(app);
  registerMcpOAuthRoutes(app);
  // Authenticated admin surface for platform-global OAuth clients.
  // Placed after the unauthenticated bootstrap set (registerMcpOAuthRoutes)
  // to make the registration order clear: bootstrap first, then admin.
  registerOAuthClientAdminRoutes(app);
  registerWhoamiRoute(app);
  registerEffectivePermissionsRoute(app);
  registerSkBootstrapRoute(app);
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
  registerAgentBriefingRoutes(app);
  registerAgentSessionRoutes(app, {
    enqueue:
      opts.agentSessionEnqueue ??
      (async (job: AgentSessionAnalyzeJob) => {
        // Lazily resolved like chatEnqueue: boot order stays intact and
        // tests that don't start a boss inject their own stub.
        await (opts.boss ?? getBoss()).send(AGENT_SESSION_ANALYZE_QUEUE, job);
      }),
  });
  registerDiscoveryRoutes(app);
  registerConversationRoutes(app);
  registerConversationAttachmentRoutes(app);
  registerFileRoutes(app);
  registerMcpCatalogRoutes(app);
  registerAiGenerateRoute(app);
  registerAiExtractRoute(app);
  registerAiRepairRoute(app);
  registerAiSummarizeRoute(app);
  registerPatchCandidateRoutes(app);
  registerOperatorRoutes(app);
  registerOperationalOverviewRoute(app);
  registerSelfHealingRoutes(app);
  registerHooksInboundRoutes(app);
  registerRequestHookRoutes(app);
  const chatRegistry = opts.chatRegistry ?? new ChatAdapterRegistry();
  registerChatRoutes(app, {
    registry: chatRegistry,
    enqueue:
      opts.chatEnqueue ??
      (async (job: ChatEventJob) => {
        // getBoss() is resolved lazily at request time so the engine
        // boot order (boss start → migrations → http listen) stays
        // intact; tests that don't start a boss don't hit this path.
        await (opts.boss ?? getBoss()).send(CHAT_EVENT_QUEUE, job);
      }),
  });
  registerChatWorkspaceRoutes(app, { registry: chatRegistry });
  registerChatIdentityRoutes(app);
  registerChatSpaceRoutes(app);
  registerSubscriptionRoutes(app);
  // GET/POST /v1/tool-approvals/decide are deliberately NOT gated by
  // requirePermission: the approver is a human with a browser and no API key.
  // Authentication is the single-use `skag_…` grant token, resolved inside the
  // handlers. Same discipline as the credential-setup and OAuth callback routes.
  registerToolApprovalRoutes(app);
  registerNotificationRoutes(app);
  registerEventRoutes(app);
  registerRbacRoutes(app);
  registerAuditLogRoutes(app);
  registerDiagnosticsRoutes(app);
  registerMcpHttpRoutes(app);
  registerCockpitRoutes(app);

  // OpenAPI document
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: OPENAPI_INFO,
  });

  // Inject security schemes manually because @hono/zod-openapi's `doc()`
  // does not accept a `components` block in this version.
  app.openAPIRegistry.registerComponent(
    "securitySchemes",
    "bearerAuth",
    SECURITY_SCHEMES.bearerAuth,
  );
  app.openAPIRegistry.registerComponent("securitySchemes", "oauth2", SECURITY_SCHEMES.oauth2);
  app.openAPIRegistry.registerComponent(
    "securitySchemes",
    "browserSession",
    SECURITY_SCHEMES.browserSession,
  );

  // Scalar UI. The page loads the Scalar bundle from jsdelivr; scope a
  // Content-Security-Policy to this response so the API origin can't be
  // turned into an arbitrary-script host — script/style are limited to
  // self + the Scalar CDN, connect to self (for /openapi.json), and the
  // page may not be framed.
  app.get("/docs", (c) => {
    c.header(
      "Content-Security-Policy",
      [
        "default-src 'none'",
        "script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'",
        "style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'",
        "img-src 'self' data: https:",
        "font-src https://cdn.jsdelivr.net data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    return c.html(SCALAR_HTML);
  });

  return app;
}
