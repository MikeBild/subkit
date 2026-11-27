import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { WorkspaceLanguageSchema } from "../../../api/index.ts";
import { AiAccessSchema } from "../../../api/operations/workspace-ai-access.ts";
import {
  browserSessionForPrincipal,
  browserSessionFromRequest,
  clearBrowserSessionCookieForRequest,
  cockpitInstallationIdFromPath,
  findOwnedSession,
  revokeBrowserSession,
  signBrowserCsrf,
  signLoginState,
} from "../../../auth/index.ts";
import { getConfig, isBrowserLoginProvider } from "../../../config/index.ts";
import { buildOAuthRedirectUri } from "../../../credentials/index.ts";
import {
  findCockpitIdentity,
  listRecentOwnedConversations,
  readStartSteps,
  readTenantBranding,
} from "../../../identity/index.ts";
import { workspaceAiAccess } from "../../../llm/index.ts";
import { ALL_PERMISSION_NAMES, can, isOperatorPrincipal } from "../../../rbac/index.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { type AppEnv, OPENAPI_INFO } from "../../openapi.ts";
import {
  NEGOTIATED_VARY,
  negotiatedPageResponse,
  renderInvalidReturnPage,
  resolvePageLook,
  wantsHtmlPage,
} from "../oauth/ui.ts";

const CockpitLoginQuery = z.object({
  return_to: z.string().max(2048).optional(),
  reauth: z
    .enum(["1"])
    .optional()
    .describe(
      "1 ends the current browser session and asks the identity provider for a fresh sign-in. Used before actions that need a sign-in younger than 5 minutes, such as revealing a card.",
    ),
});

const CockpitBootstrapResponse = z
  .object({
    principal: z.object({
      id: z.string(),
      kind: z.literal("user"),
      email: z.string().nullable(),
      display_name: z.string().nullable(),
      role_name: z.string().nullable(),
      is_owner: z.boolean().describe("True when this verified sign-in identity owns the workspace"),
      provider: z.literal("browser_session"),
    }),
    tenant: z.object({
      id: z.string().uuid(),
      slug: z.string(),
      display_name: z.string(),
      timezone: z.string().describe("IANA time zone of the workspace"),
      language: WorkspaceLanguageSchema,
      origin: z.enum(["self_hosted", "self_service"]),
      engine_operator: z
        .boolean()
        .describe(
          "True when this workspace is the engine operator and may change the whole engine",
        ),
    }),
    session: z.object({
      expires_at: z.string().datetime(),
      absolute_expires_at: z.string().datetime().nullable(),
    }),
    start_steps: z
      .object({
        hidden: z.boolean().describe("The signed-in person dismissed the first steps"),
        connector: z.boolean(),
        workflow: z.boolean(),
        run: z.boolean(),
        people: z.boolean(),
        client: z.boolean(),
      })
      .describe(
        "First steps of a workspace; each flag is true once at least one exists: a connector, a workflow, a run, a second person, a connected client or personal API key",
      ),
    ai_access: AiAccessSchema,
    identity_memberships: z
      .boolean()
      .describe("Verified browser identity supports workspace membership selection"),
    permissions: z.array(z.string()),
    csrf_token: z.string(),
    version: z.string(),
    oauth_callback_url: z
      .string()
      .nullable()
      .describe(
        "The address an OAuth app must allow as its redirect URI for a connector that signs in with an account (`/v1/oauth/callback` on the engine's public origin). Null when no public origin resolves — such a sign-in cannot start until server.public_base_url is set.",
      ),
    recent_conversations: z.array(
      z.object({
        id: z.string().uuid(),
        title: z.string().nullable(),
        status: z.enum(["active", "awaiting_input", "committed", "abandoned"]),
        updated_at: z.string().datetime(),
      }),
    ),
    branding: z
      .object({
        configured: z.boolean(),
        revision: z.number().int(),
        display_name: z.string().nullable(),
        subtitle: z.string().nullable(),
        palette: z.enum(["standard", "indigo", "teal"]).nullable(),
        logos: z.object({ light: z.boolean(), dark: z.boolean() }),
        logo_urls: z.object({ light: z.string().nullable(), dark: z.string().nullable() }),
        app_icon: z.boolean(),
        app_icon_urls: z.object({
          icon_192: z.string().nullable(),
          icon_512: z.string().nullable(),
        }),
      })
      .optional(),
  })
  .openapi("CockpitBootstrapResponse");

const loginRoute = createRoute({
  method: "get",
  path: "/v1/identity/cockpit-login",
  tags: ["identity"],
  summary: "Start a browser login for the SubKit Cockpit",
  request: { query: CockpitLoginQuery },
  responses: {
    302: {
      description: "Redirect to the provider-neutral login funnel",
      headers: { Location: { schema: { type: "string" } } },
    },
    400: {
      description: "Invalid return path",
      content: {
        "application/json": { schema: ErrorSchema },
        "text/html": { schema: z.string() },
      },
    },
  },
});

const bootstrapRoute = createRoute({
  method: "get",
  path: "/v1/cockpit/bootstrap",
  tags: ["identity"],
  summary: "Resolve the Cockpit session, tenant and effective navigation permissions",
  security: [{ browserSession: [] }],
  responses: {
    200: {
      description: "Cockpit session",
      content: { "application/json": { schema: CockpitBootstrapResponse } },
    },
    401: {
      description: "Browser session required",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

function safeCockpitReturnPath(raw: string | undefined): string | null {
  const value = raw ?? "/cockpit";
  const cockpit =
    value === "/cockpit" || value.startsWith("/cockpit/") || value.startsWith("/cockpit?");
  if (!cockpit || value.startsWith("//")) {
    return null;
  }
  try {
    const parsed = new URL(value, "https://subkit.invalid");
    return parsed.origin === "https://subkit.invalid" ? `${parsed.pathname}${parsed.search}` : null;
  } catch {
    return null;
  }
}

export function registerCockpitIdentityRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(loginRoute, async (c) => {
    const query = c.req.valid("query");
    const reauth = query.reauth === "1";
    const returnTo = safeCockpitReturnPath(query.return_to);
    if (!returnTo) {
      if (wantsHtmlPage(c.req.header("accept")))
        return negotiatedPageResponse(
          renderInvalidReturnPage(resolvePageLook(c.req.raw.headers)),
          400,
        );
      return c.json(
        { code: "invalid_return_to", message: "return_to must stay under /cockpit" },
        400,
        { vary: NEGOTIATED_VARY },
      );
    }
    const installationId = cockpitInstallationIdFromPath(c.req.path);
    if (installationId && !returnTo.startsWith(`/cockpit/i/${installationId}/`)) {
      return c.json(
        { code: "invalid_return_to", message: "return_to must stay in this Cockpit installation" },
        400,
        { vary: NEGOTIATED_VARY },
      );
    }
    const loginState = await signLoginState({
      redirect_to: returnTo,
      ...(installationId ? { installation_id: installationId } : {}),
      ...(reauth ? { reauth: true } : {}),
    });
    if (
      reauth &&
      c.req.header("sec-fetch-site") === "same-origin" &&
      getConfig().auth.providers.some(isBrowserLoginProvider)
    ) {
      const current = await browserSessionFromRequest(c.req.raw);
      await revokeBrowserSession(c.get("db"), current, "reauthentication");
      c.header("set-cookie", clearBrowserSessionCookieForRequest(c.req.raw));
      c.header("cache-control", "no-store");
    }
    return c.redirect(
      `/v1/identity/login/start?login_state=${encodeURIComponent(loginState)}`,
      302,
    );
  });

  app.openapi(bootstrapRoute, async (c) => {
    const principal = requireAuth(c);
    if (principal.kind !== "user") {
      return c.json({ code: "browser_session_required", message: "browser session required" }, 401);
    }
    const payload = await browserSessionForPrincipal(c.req.raw, principal);
    if (!payload) {
      return c.json({ code: "browser_session_required", message: "browser session required" }, 401);
    }
    const db = c.get("db");
    const sessionRow = await findOwnedSession(db, {
      session_id: payload.session_id,
      tenant_id: principal.tenant_id,
      user_id: principal.id,
    });
    const identityRow = await findCockpitIdentity(db, principal.tenant_id, principal.id);
    if (!sessionRow || !identityRow) {
      return c.json({ code: "browser_session_required", message: "browser session required" }, 401);
    }

    const decisions = await Promise.all(
      ALL_PERMISSION_NAMES.map(async (permission) => ({
        permission,
        allow: (
          await can(db, {
            tenant_id: principal.tenant_id,
            principal,
            permission,
            quiet: true,
          })
        ).allow,
      })),
    );
    const permissions = decisions
      .filter((decision) => decision.allow)
      .map((decision) => decision.permission)
      .sort();
    const mayReadConversations = permissions.includes("conversation:read");
    const recent = mayReadConversations
      ? await listRecentOwnedConversations(db, principal.tenant_id, principal.id)
      : [];
    const branding = await readTenantBranding({ tenant_id: principal.tenant_id }, db);
    const startSteps = await readStartSteps(principal.tenant_id, db);

    return c.json(
      {
        principal: {
          id: principal.id,
          kind: "user" as const,
          email: identityRow.email,
          display_name: identityRow.display_name,
          role_name: identityRow.role_name,
          is_owner:
            sessionRow.auth_identity_id !== null &&
            sessionRow.auth_identity_id === identityRow.auth_identity_id &&
            sessionRow.auth_identity_id === identityRow.tenant_owner_identity_id,
          provider: "browser_session" as const,
        },
        tenant: {
          id: identityRow.tenant_id,
          slug: identityRow.tenant_slug,
          display_name: identityRow.tenant_display_name,
          timezone: identityRow.tenant_timezone,
          language: identityRow.tenant_language,
          origin: identityRow.tenant_origin,
          engine_operator: await isOperatorPrincipal(db, principal),
        },
        session: {
          expires_at: sessionRow.expires_at.toISOString(),
          absolute_expires_at: sessionRow.absolute_expires_at?.toISOString() ?? null,
        },
        start_steps: { hidden: identityRow.start_steps_hidden_at !== null, ...startSteps },
        ai_access: workspaceAiAccess({
          id: identityRow.tenant_id,
          origin: identityRow.tenant_origin,
        }),
        identity_memberships: sessionRow.auth_identity_id !== null && !payload.installation_id,
        permissions,
        csrf_token: await signBrowserCsrf(payload),
        version: OPENAPI_INFO.version,
        oauth_callback_url: buildOAuthRedirectUri({ req: c.req.raw }),
        recent_conversations: recent.map((row) => ({
          id: row.id,
          title: row.title,
          status: row.status,
          updated_at: row.updated_at.toISOString(),
        })),
        branding,
      },
      200,
    );
  });
}
