import type { OpenAPIHono } from "@hono/zod-openapi";
import type { PgBoss } from "pg-boss";
import { createTokenExchangeProvider } from "../auth/oauth/token-exchange.ts";
import { createApiKeyProvider } from "../auth/providers/api-key.ts";
import { createBrowserSessionProvider } from "../auth/providers/browser-session.ts";
import { createMcpOAuthAuthProvider } from "../auth/providers/mcp-oauth.ts";
import { createOidcBearerProvider } from "../auth/providers/oidc-bearer.ts";
import { createPortalTokenProvider } from "../auth/providers/portal-token.ts";
import { AuthProviderRegistry } from "../auth/registry.ts";
import { ChatAdapterRegistry } from "../chat/registry.ts";
import { getConfig } from "../config/loader.ts";
import type { Config } from "../config/schema.ts";
import { type Db, getDb } from "../db/client.ts";
import { applyWorkspaceContentSeeds } from "../identity/workspace-seeds.ts";
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
import { clientIpMiddleware } from "./client-ip.ts";
import { registerCockpitRoutes } from "./cockpit.ts";
import { registerCockpitInstallationAssets } from "./cockpit-installation-assets.ts";
import { registerChangeAnnouncements } from "./middleware/announce-change.ts";
import { authMiddleware } from "./middleware/auth.ts";
import { browserCsrfMiddleware } from "./middleware/browser-csrf.ts";
import { browserTenantMiddleware } from "./middleware/browser-tenant.ts";
import {
  requireCockpitInstallation,
  resolveCockpitPushContext,
} from "./middleware/cockpit-installation.ts";
import { guardCockpitInstallationStreams } from "./middleware/cockpit-installation-stream.ts";
import { errorMiddleware, mapKnownErrorResponse } from "./middleware/error.ts";
import { hostedIngressRateLimit, hostedTenantRateLimit } from "./middleware/hosted-rate-limit.ts";
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
import { registerAppRoutes } from "./routes/apps.ts";
import { registerAuditLogRoutes } from "./routes/audit-log.ts";
import { registerBotRoute } from "./routes/bot.ts";
import { registerCategoryRoutes } from "./routes/categories.ts";
import { registerChatRoutes } from "./routes/chat.ts";
import { registerChatIdentityRoutes } from "./routes/chat-identities.ts";
import { registerChatSpaceRoutes } from "./routes/chat-spaces.ts";
import { registerChatWorkspaceRoutes } from "./routes/chat-workspaces.ts";
import { registerCockpitEventRoutes } from "./routes/cockpit-events.ts";
import { registerCockpitInstallationRoutes } from "./routes/cockpit-installations.ts";
import { registerCockpitPushRoutes } from "./routes/cockpit-push.ts";
import { registerComposeRoute } from "./routes/compose.ts";
import { registerConnectionRoutes } from "./routes/connections/index.ts";
import { registerConnectorDiscoveryRoutes } from "./routes/connector-discovery.ts";
import { registerConnectorDocsRoutes } from "./routes/connector-docs.ts";
import { registerConnectorTemplateRoutes } from "./routes/connector-templates/index.ts";
import { registerConnectorRoutes } from "./routes/connectors/index.ts";
import { registerConversationAttachmentRoutes } from "./routes/conversation-attachments.ts";
import { registerConversationRoutes } from "./routes/conversations/index.ts";
import { registerCredentialRoutes } from "./routes/credentials.ts";
import { registerDiagnosticsRoutes } from "./routes/diagnostics/index.ts";
import { registerDiscoveryRoutes } from "./routes/discovery.ts";
import { registerDocsImageRoutes } from "./routes/docs-images.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerExecutionRoutes } from "./routes/executions/index.ts";
import { registerFileRoutes } from "./routes/files.ts";
import { registerFileManageRoutes } from "./routes/files-manage.ts";
import { registerHealthRoute } from "./routes/health.ts";
import { registerHooksInboundRoutes } from "./routes/hooks-inbound.ts";
import { registerHostedStorageRoutes } from "./routes/hosted-storage.ts";
import { registerHostedWorkRoutes } from "./routes/hosted-work.ts";
import { registerApiKeyRoutes } from "./routes/identity/api-keys.ts";
import { registerCliSessionRoute } from "./routes/identity/cli-session.ts";
import { registerCockpitIdentityRoutes } from "./routes/identity/cockpit.ts";
import { registerInviteRoutes } from "./routes/identity/invites.ts";
import { registerLoginRoutes } from "./routes/identity/login.ts";
import { registerMembershipRoutes } from "./routes/identity/memberships.ts";
import { registerOnboardingRoutes } from "./routes/identity/onboarding.ts";
import { registerOwnedTenantRoutes } from "./routes/identity/owned-tenant.ts";
import { registerEffectivePermissionsRoute } from "./routes/identity/permissions.ts";
import { registerPortalTokenRoutes } from "./routes/identity/portal-tokens.ts";
import { registerProviderIdentityRoutes } from "./routes/identity/provider-identities.ts";
import { registerProvidersRoute } from "./routes/identity/providers.ts";
import { registerIdentitySessionsRoute } from "./routes/identity/sessions.ts";
import { registerSkBootstrapRoute } from "./routes/identity/sk-bootstrap.ts";
import { registerSystemAccountRoutes } from "./routes/identity/system-accounts.ts";
import { registerTenantRoutes } from "./routes/identity/tenants.ts";
import { registerUserRoutes } from "./routes/identity/users.ts";
import { registerWhoamiRoute } from "./routes/identity/whoami.ts";
import { registerWorkspaceRoutes } from "./routes/identity/workspace.ts";
import { registerInstallRoute } from "./routes/install.ts";
import { registerInstallBinaryRoute } from "./routes/install-binary.ts";
import { registerInstallClipperRoute } from "./routes/install-clipper.ts";
import { registerInstallSkillRoute } from "./routes/install-skill.ts";
import { registerIntakeRoutes } from "./routes/intake.ts";
import { registerKnowledgeSourceRoutes } from "./routes/knowledge-sources.ts";
import { registerLlmsTxtRoutes } from "./routes/llms-txt.ts";
import { registerMcpCatalogRoutes } from "./routes/mcp-catalog.ts";
import { registerMetricsRoute } from "./routes/metrics.ts";
import { registerNotificationRoutes } from "./routes/notifications/index.ts";
import {
  HTML_PAGE_HEADERS,
  NEGOTIATED_VARY,
  renderNotFoundPage,
  renderServerErrorPage,
  resolvePageLook,
  wantsHtmlPage,
} from "./routes/oauth/ui.ts";
import { registerMcpOAuthRoutes } from "./routes/oauth.ts";
import { registerOAuthClientAdminRoutes } from "./routes/oauth-clients.ts";
import { registerAttentionRoute } from "./routes/operator/attention.ts";
import { registerOperatorRoutes } from "./routes/operator/health-digest.ts";
import { registerOperationalOverviewRoute } from "./routes/operator/operational-overview.ts";
import { registerPackageRoutes } from "./routes/packages.ts";
import { registerPatchCandidateRoutes } from "./routes/patch-candidates.ts";
import { registerProductStatusRoutes } from "./routes/product-status.ts";
import { registerRbacRoutes } from "./routes/rbac/index.ts";
import { registerRequestHookRoutes } from "./routes/request-hooks.ts";
import { registerRootRoute } from "./routes/root.ts";
import { registerRuntimeConfigRoutes } from "./routes/runtime-config.ts";
import { registerSecretApprovalRoutes } from "./routes/secret-approvals.ts";
import { registerSelfHealingRoutes } from "./routes/self-healing.ts";
import { registerSettingsRoutes } from "./routes/settings.ts";
import { registerSetupRoute } from "./routes/setup.ts";
import { registerSkillCandidateRoutes } from "./routes/skill-candidates.ts";
import { registerSkillRoutes } from "./routes/skills.ts";
import { registerStatsRoutes } from "./routes/stats/index.ts";
import { registerStatusRoute } from "./routes/status.ts";
import { registerSubscriptionRoutes } from "./routes/subscriptions.ts";
import { registerSystemRestartRoutes } from "./routes/system-restart.ts";
import { registerTenantBrandingRoutes } from "./routes/tenant-branding.ts";
import { registerToolApprovalRoutes } from "./routes/tool-approvals.ts";
import { registerWorkflowRoutes } from "./routes/workflows.ts";

export interface CreateAppOptions {
  db?: Db;
  boss?: PgBoss;
  registry?: AuthProviderRegistry;
  chatRegistry?: ChatAdapterRegistry;
  chatEnqueue?: (job: ChatEventJob) => Promise<void>;
  agentSessionEnqueue?: (job: AgentSessionAnalyzeJob) => Promise<void>;
  rateLimit?: { max?: number; windowMs?: number };
  seedWorkspace?: (tenant_id: string, db: Db) => Promise<void>;
}

function lazyDb(): Db {
  let resolved: Db | null = null;
  const target = (): Db => {
    resolved ??= getDb();
    return resolved;
  };
  return new Proxy({} as Db, {
    get(_shell, prop) {
      const real = target();
      const value = Reflect.get(real, prop, real);
      return typeof value === "function" ? value.bind(real) : value;
    },
    has(_shell, prop) {
      return Reflect.has(target(), prop);
    },
  });
}

export function buildDefaultRegistry(db?: Db, cfg?: Config["auth"]): AuthProviderRegistry {
  const reg = new AuthProviderRegistry();
  const boundDb = db ?? lazyDb();

  let auth = cfg;
  if (!auth) {
    try {
      auth = getConfig().auth;
    } catch {}
  }
  const enableMcpOAuth = auth?.mcp_oauth.enabled ?? true;
  const registered: string[] = [];

  reg.register(createOidcBearerProvider({ db: boundDb }));
  registered.push("oidc_bearer");
  if (enableMcpOAuth) {
    reg.register(createMcpOAuthAuthProvider({ db: boundDb }));
    registered.push("mcp_oauth");
  }
  reg.register(createPortalTokenProvider({ db: boundDb }));
  registered.push("portal_token");
  reg.register(createTokenExchangeProvider({ db: boundDb }));
  registered.push("token_exchange");
  reg.register(createApiKeyProvider({ db: boundDb }));
  registered.push("api_key");
  reg.register(createBrowserSessionProvider({ db: boundDb }));
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
<html lang="en">
  <head>
    <title>SubKit — API reference</title>
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

  app.use("*", traceMiddleware());
  app.use("*", loggingMiddleware());
  app.use("*", metricsMiddleware());
  app.use("*", errorMiddleware());

  app.onError((err, c) => {
    const traceId = c.get("trace_id") ?? null;
    const principal = c.get("principal") as { tenant_id?: string } | undefined;
    const path = new URL(c.req.url).pathname;
    const knownResponse = mapKnownErrorResponse(c, err);
    if (knownResponse) return knownResponse;
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
    if (wantsHtmlPage(c.req.header("accept")))
      return c.body(renderServerErrorPage(resolvePageLook(c.req.raw.headers), traceId), 500, {
        ...HTML_PAGE_HEADERS,
        vary: NEGOTIATED_VARY,
      });
    return c.json(
      {
        code: "internal_error",
        message: "internal error",
        trace_id: traceId,
      },
      500,
      { vary: NEGOTIATED_VARY },
    );
  });
  app.notFound((c) =>
    wantsHtmlPage(c.req.header("accept"))
      ? c.body(renderNotFoundPage(resolvePageLook(c.req.raw.headers)), 404, {
          ...HTML_PAGE_HEADERS,
          vary: NEGOTIATED_VARY,
        })
      : c.text("404 Not Found", 404, { vary: NEGOTIATED_VARY }),
  );
  if (opts.db) {
    const boundDb = opts.db;
    app.use("*", async (c, next) => {
      c.set("db", boundDb);
      await next();
    });
  } else {
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
  app.use("*", clientIpMiddleware());
  app.use("*", hostedIngressRateLimit());
  app.use("*", authMiddleware(registry));
  app.use("/cockpit/i/:installationId/api/*", requireCockpitInstallation());
  app.use("/cockpit/i/:installationId/api/*", guardCockpitInstallationStreams());
  app.use("*", hostedTenantRateLimit());
  app.use("*", rateLimitMiddleware(opts.rateLimit ?? {}));
  app.use("/v1/*", browserCsrfMiddleware());
  app.use("/v1/*", browserTenantMiddleware());
  registerChangeAnnouncements(app);

  registerHealthRoute(app, opts.db ? { db: opts.db } : {});
  registerInstallRoute(app);
  registerInstallSkillRoute(app);
  registerInstallClipperRoute(app);
  registerInstallBinaryRoute(app);
  registerSetupRoute(app);
  registerStatusRoute(app);
  registerStatsRoutes(app);
  registerRuntimeConfigRoutes(app);
  registerSystemRestartRoutes(app);
  registerSettingsRoutes(app);
  registerHostedWorkRoutes(app);
  registerHostedStorageRoutes(app);
  registerSecretApprovalRoutes(app);
  registerConnectionRoutes(app);
  registerMetricsRoute(app);
  registerLlmsTxtRoutes(app);
  registerDocsImageRoutes(app);
  registerComposeRoute(app);
  registerRootRoute(app);
  registerBotRoute(app);
  registerTenantRoutes(app);
  registerMembershipRoutes(app);
  registerOwnedTenantRoutes(app);
  registerOnboardingRoutes(app, opts.seedWorkspace ?? applyWorkspaceContentSeeds);
  registerUserRoutes(app);
  registerWorkspaceRoutes(app);
  registerProviderIdentityRoutes(app);
  registerInviteRoutes(app);
  registerSystemAccountRoutes(app);
  registerApiKeyRoutes(app);
  registerPortalTokenRoutes(app);
  registerProvidersRoute(app);
  registerIdentitySessionsRoute(app);
  registerCliSessionRoute(app);
  registerLoginRoutes(app);
  registerCockpitIdentityRoutes(app);
  registerCockpitInstallationRoutes(app);
  registerCockpitPushRoutes(app, resolveCockpitPushContext);
  registerTenantBrandingRoutes(app);
  registerMcpOAuthRoutes(app);
  registerOAuthClientAdminRoutes(app);
  registerWhoamiRoute(app);
  registerEffectivePermissionsRoute(app);
  registerSkBootstrapRoute(app);
  registerWorkflowRoutes(app);
  registerExecutionRoutes(app);
  registerProductStatusRoutes(app);
  registerAppRoutes(app);
  registerConnectorTemplateRoutes(app);
  registerConnectorRoutes(app);
  registerConnectorDiscoveryRoutes(app);
  registerConnectorDocsRoutes(app);
  registerCredentialRoutes(app);
  registerSkillRoutes(app);
  registerCategoryRoutes(app);
  registerIntakeRoutes(app);
  registerKnowledgeSourceRoutes(app);
  registerSkillCandidateRoutes(app);
  registerAgentBriefingRoutes(app);
  registerAgentSessionRoutes(app, {
    enqueue:
      opts.agentSessionEnqueue ??
      (async (job: AgentSessionAnalyzeJob) => {
        await (opts.boss ?? getBoss()).send(AGENT_SESSION_ANALYZE_QUEUE, job);
      }),
  });
  registerDiscoveryRoutes(app);
  registerConversationRoutes(app);
  registerConversationAttachmentRoutes(app);
  registerFileRoutes(app);
  registerFileManageRoutes(app);
  registerPackageRoutes(app);
  registerMcpCatalogRoutes(app);
  registerAiGenerateRoute(app);
  registerAiExtractRoute(app);
  registerAiRepairRoute(app);
  registerAiSummarizeRoute(app);
  registerPatchCandidateRoutes(app);
  registerOperatorRoutes(app);
  registerAttentionRoute(app);
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
        await (opts.boss ?? getBoss()).send(CHAT_EVENT_QUEUE, job);
      }),
  });
  registerChatWorkspaceRoutes(app, { registry: chatRegistry });
  registerChatIdentityRoutes(app);
  registerChatSpaceRoutes(app);
  registerSubscriptionRoutes(app);
  registerToolApprovalRoutes(app);
  registerNotificationRoutes(app);
  registerEventRoutes(app);
  registerCockpitEventRoutes(app);
  registerRbacRoutes(app);
  registerAuditLogRoutes(app);
  registerDiagnosticsRoutes(app);
  registerMcpHttpRoutes(app);
  const cockpitApiRoutes = app.routes.filter((route) => route.path.startsWith("/v1/"));
  for (const route of cockpitApiRoutes) {
    app.on(route.method, `/cockpit/i/:installationId/api${route.path}`, route.handler);
  }
  registerCockpitInstallationAssets(app);
  registerCockpitRoutes(app);

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: OPENAPI_INFO,
  });

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
