import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  browserSessionForPrincipal,
  findOwnedSession,
  issueBrowserSession,
} from "../../auth/index.ts";
import {
  createOrReuseCockpitInstallation,
  listActiveCockpitInstallations,
  revokeCockpitInstallation,
} from "../../identity/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import type { AppEnv } from "../openapi.ts";

const InstallationFailure = z.object({ code: z.string(), message: z.string().optional() });
const EmptyBody = z.object({}).strict();
const InstallationKind = z.enum(["browser", "desktop"]);
const InstallationResponse = z.object({
  id: z.string().uuid(),
  kind: InstallationKind,
  start_url: z.string(),
  manifest_url: z.string(),
  created: z.boolean(),
});
const InstallationListItem = z
  .object({
    id: z.string().uuid(),
    kind: InstallationKind,
    device_label: z
      .string()
      .nullable()
      .describe("Name the desktop device gave itself; null for the installed web app."),
    created_at: z.string().datetime(),
    last_used_at: z
      .string()
      .datetime()
      .nullable()
      .describe("Last request a session of this installation made; null when it was never used."),
    current: z
      .boolean()
      .describe("True for the installation the asking session itself belongs to."),
  })
  .openapi("CockpitInstallationListItem");
const currentInstallationRoute = createRoute({
  method: "get",
  path: "/v1/cockpit/installations",
  tags: ["cockpit"],
  summary: "Read the current browser owner's active workspace installations",
  description:
    "Answers a browser session and the session of an installed app or desktop device alike. `installation` names the installed web app and is filled for the plain browser session only; `installations` lists every active installation of the person and marks the asking one with `current`.",
  security: [{ browserSession: [] }],
  responses: {
    200: {
      description: "Current installation",
      content: {
        "application/json": {
          schema: z.object({
            installation: InstallationResponse.omit({ created: true }).nullable(),
            installations: z
              .array(InstallationListItem)
              .describe(
                "Every active installation of the signed-in person in this workspace: the installed web app and each desktop device. Each one is revoked on its own.",
              ),
          }),
        },
      },
    },
    401: {
      description: "Browser session required",
      content: { "application/json": { schema: InstallationFailure } },
    },
  },
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
  summary:
    "Revoke one of the current browser user's Cockpit installations, web app or desktop device",
  description:
    "Ends every session of that one installation at once and stops its notifications. Other installations of the person stay signed in. A plain browser session may revoke any of the person's installations; the session of an installation may revoke only itself.",
  request: { params: z.object({ installationId: z.string().uuid() }) },
  responses: {
    204: { description: "Cockpit installation revoked" },
    401: {
      description: "Browser session required",
      content: { "application/json": { schema: InstallationFailure } },
    },
    403: {
      description: "The session of an installation may revoke only its own installation",
      content: { "application/json": { schema: InstallationFailure } },
    },
    404: {
      description: "Installation not found",
      content: { "application/json": { schema: InstallationFailure } },
    },
  },
});

const REVOCATION_TARGET = /\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/?$/i;

export function revocationTarget(path: string): string | null {
  return REVOCATION_TARGET.exec(path)?.[1]?.toLowerCase() ?? null;
}

export function registerCockpitInstallationRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(currentInstallationRoute, async (c) => {
    const principal = requireAuth(c);
    const session = await browserSessionForPrincipal(c.req.raw, principal);
    if (principal.provider !== "browser_session" || principal.kind !== "user" || !session)
      return c.json({ code: "browser_session_required" }, 401);
    const currentId = session.installation_id ?? null;
    const installations = await listActiveCockpitInstallations(
      c.get("db"),
      principal.tenant_id,
      principal.id,
    );
    const installation = currentId
      ? undefined
      : installations.find((candidate) => candidate.kind === "browser");
    return c.json(
      {
        installation: installation
          ? {
              id: installation.id,
              kind: installation.kind,
              start_url: `/cockpit/i/${installation.id}/`,
              manifest_url: `/cockpit/i/${installation.id}/manifest.webmanifest`,
            }
          : null,
        installations: installations.map((candidate) => ({
          id: candidate.id,
          kind: candidate.kind,
          device_label: candidate.device_label,
          created_at: candidate.created_at.toISOString(),
          last_used_at: candidate.last_used_at ? candidate.last_used_at.toISOString() : null,
          current: candidate.id === currentId,
        })),
      },
      200,
      { "cache-control": "private, no-store", vary: "Cookie" },
    );
  });
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
    const rootSession = await findOwnedSession(c.get("db"), {
      session_id: session.session_id,
      tenant_id: principal.tenant_id,
      user_id: principal.id,
    });
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
        kind: installation.kind,
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
    if (principal.provider !== "browser_session" || principal.kind !== "user" || !session) {
      return c.json({ code: "browser_session_required" }, 401);
    }
    const target = revocationTarget(c.req.path);
    if (!target) return c.json({ code: "not_found" }, 404);
    if (session.installation_id && session.installation_id !== target)
      return c.json(
        {
          code: "own_installation_only",
          message: "an installed app can sign out only itself; use the browser for other devices",
        },
        403,
      );
    const revoked = await revokeCockpitInstallation(
      c.get("db"),
      target,
      principal.tenant_id,
      principal.id,
    );
    return revoked ? c.body(null, 204) : c.json({ code: "not_found" }, 404);
  });
}
