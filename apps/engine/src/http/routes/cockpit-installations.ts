import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { browserSessionForPrincipal, issueBrowserSession } from "../../auth/index.ts";
import { sessions } from "../../db/schema/identity.ts";
import {
  createOrReuseCockpitInstallation,
  revokeCockpitInstallation,
} from "../../identity/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import type { AppEnv } from "../openapi.ts";

const InstallationFailure = z.object({ code: z.string(), message: z.string().optional() });
const EmptyBody = z.object({}).strict();
const InstallationResponse = z.object({
  id: z.string().uuid(),
  start_url: z.string(),
  manifest_url: z.string(),
  created: z.boolean(),
});
const createInstallationRoute = createRoute({
  method: "post",
  path: "/v1/cockpit/installations",
  tags: ["cockpit"],
  summary: "Create or reuse the current browser user's Cockpit installation",
  request: { body: { required: true, content: { "application/json": { schema: EmptyBody } } } },
  security: [{ browserSession: [] }],
  responses: {
    401: {
      description: "Browser session required",
      content: { "application/json": { schema: InstallationFailure } },
    },
    403: {
      description: "Installation or workspace unavailable",
      content: { "application/json": { schema: InstallationFailure } },
    },
    500: {
      description: "Session could not be issued",
      content: { "application/json": { schema: InstallationFailure } },
    },
    200: {
      description: "Cockpit installation",
      content: { "application/json": { schema: InstallationResponse } },
    },
  },
});
const revokeInstallationRoute = createRoute({
  method: "delete",
  path: "/v1/cockpit/installations/{installationId}",
  tags: ["cockpit"],
  summary: "Revoke the current browser user's Cockpit installation",
  request: { params: z.object({ installationId: z.string().uuid() }) },
  responses: {
    204: { description: "Cockpit installation revoked" },
    404: { description: "Installation not found" },
  },
});

export function registerCockpitInstallationRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(createInstallationRoute, async (c) => {
    const principal = requireAuth(c);
    const session = await browserSessionForPrincipal(c.req.raw, principal);
    if (
      principal.provider !== "browser_session" ||
      principal.kind !== "user" ||
      !session ||
      session.installation_id
    ) {
      return c.json({ code: "browser_session_required" }, 401);
    }
    const { installation, created } = await createOrReuseCockpitInstallation(
      c.get("db"),
      principal.tenant_id,
      principal.id,
    );
    const [rootSession] = await c
      .get("db")
      .select({ auth_identity_id: sessions.auth_identity_id })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, session.session_id),
          eq(sessions.tenant_id, principal.tenant_id),
          eq(sessions.user_id, principal.id),
        ),
      )
      .limit(1);
    const issued = await issueBrowserSession({
      db: c.get("db"),
      tenantId: installation.tenant_id,
      userId: installation.owner_user_id,
      ...(rootSession?.auth_identity_id ? { authIdentityId: rootSession.auth_identity_id } : {}),
      installationId: installation.id,
      redirectTo: `/cockpit/i/${installation.id}/`,
      via: "cockpit_installation",
      metadata: { installation_id: installation.id, created },
    });
    if (issued.status !== 302) {
      const failure = InstallationFailure.parse(await issued.json());
      return c.json(failure, issued.status === 403 ? 403 : 500);
    }
    return c.json(
      {
        id: installation.id,
        start_url: `/cockpit/i/${installation.id}/`,
        manifest_url: `/cockpit/i/${installation.id}/manifest.webmanifest`,
        created,
      },
      200,
      { "set-cookie": issued.headers.get("set-cookie") ?? "", "cache-control": "no-store" },
    );
  });

  app.openapi(revokeInstallationRoute, async (c) => {
    const principal = requireAuth(c);
    const session = await browserSessionForPrincipal(c.req.raw, principal);
    if (
      principal.provider !== "browser_session" ||
      principal.kind !== "user" ||
      !session ||
      session.installation_id
    ) {
      return c.json({ code: "browser_session_required" }, 401);
    }
    const revoked = await revokeCockpitInstallation(
      c.get("db"),
      c.req.valid("param").installationId,
      principal.tenant_id,
      principal.id,
    );
    return revoked ? c.body(null, 204) : c.json({ code: "not_found" }, 404);
  });
}
