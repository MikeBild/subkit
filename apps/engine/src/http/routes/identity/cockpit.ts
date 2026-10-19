import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import {
  browserSessionForPrincipal,
  signBrowserCsrf,
  signLoginState,
} from "../../../auth/index.ts";
import { buildOAuthRedirectUri } from "../../../credentials/index.ts";
import { conversations } from "../../../db/schema/conversations.ts";
import { roles, sessions, tenants, users } from "../../../db/schema/index.ts";
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
});

const CockpitBootstrapResponse = z
  .object({
    principal: z.object({
      id: z.string(),
      kind: z.literal("user"),
      email: z.string().nullable(),
      role_name: z.string().nullable(),
      provider: z.literal("browser_session"),
    }),
    tenant: z.object({
      id: z.string().uuid(),
      slug: z.string(),
      display_name: z.string(),
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
    const returnTo = safeCockpitReturnPath(c.req.valid("query").return_to);
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
    const loginState = await signLoginState({ redirect_to: returnTo });
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
    const [sessionRow] = await db
      .select({
        auth_identity_id: sessions.auth_identity_id,
        expires_at: sessions.expires_at,
        absolute_expires_at: sessions.absolute_expires_at,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, payload.session_id),
          eq(sessions.tenant_id, principal.tenant_id),
          eq(sessions.user_id, principal.id),
        ),
      )
      .limit(1);
    const [identityRow] = await db
      .select({
        email: users.email,
        role_name: roles.name,
        tenant_id: tenants.id,
        tenant_slug: tenants.slug,
        tenant_display_name: tenants.display_name,
      })
      .from(users)
      .innerJoin(tenants, eq(tenants.id, users.tenant_id))
      .leftJoin(roles, eq(roles.id, users.role_id))
      .where(and(eq(users.id, principal.id), eq(users.tenant_id, principal.tenant_id)))
      .limit(1);
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
      ? await db
          .select({
            id: conversations.id,
            title: conversations.title,
            status: conversations.status,
            updated_at: conversations.updated_at,
          })
          .from(conversations)
          .where(
            and(
              eq(conversations.tenant_id, principal.tenant_id),
              eq(conversations.owner_id, principal.id),
            ),
          )
          .orderBy(desc(conversations.updated_at))
          .limit(10)
      : [];

    return c.json(
      {
        principal: {
          id: principal.id,
          kind: "user" as const,
          email: identityRow.email,
          role_name: identityRow.role_name,
          provider: "browser_session" as const,
        },
        tenant: {
          id: identityRow.tenant_id,
          slug: identityRow.tenant_slug,
          display_name: identityRow.tenant_display_name,
          engine_operator: await isOperatorPrincipal(db, principal),
        },
        session: {
          expires_at: sessionRow.expires_at.toISOString(),
          absolute_expires_at: sessionRow.absolute_expires_at?.toISOString() ?? null,
        },
        identity_memberships: sessionRow.auth_identity_id !== null,
        permissions,
        csrf_token: await signBrowserCsrf(payload),
        version: OPENAPI_INFO.version,
        oauth_callback_url: buildOAuthRedirectUri({ req: c.req.raw }),
        recent_conversations: recent.map((row) => ({
          ...row,
          updated_at: row.updated_at.toISOString(),
        })),
      },
      200,
    );
  });
}
