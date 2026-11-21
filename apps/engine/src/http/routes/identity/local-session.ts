import type { OpenAPIHono } from "@hono/zod-openapi";
import { LAUNCH_SECRET_HEADER, LOCAL_WORKSPACE_PATHS } from "@shared/device/local-launch.ts";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  canonicalBrowserPath,
  issueBrowserSession,
  recordAuthFailure,
} from "../../../auth/index.ts";
import {
  createOrReuseDesktopInstallation,
  ensureLocalOwner,
  LocalSessionRequestSchema,
  type LocalWorkspace,
  launchSecretMatches,
  localHostAllowed,
  unavailableLocally,
} from "../../../identity/index.ts";
import { logger, withContext } from "../../../logging/index.ts";
import { normalizeClientIp } from "../../client-ip.ts";
import type { AppEnv } from "../../openapi.ts";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const LocalPowerSchema = z
  .object({ on_battery: z.boolean(), low_power_mode: z.boolean().optional() })
  .strict();

const OWNER_REFUSALS = {
  owner_required: { status: 400, message: "the first local sign-in names the owner" },
  not_local_workspace: { status: 409, message: "this database already holds a server workspace" },
  owner_unavailable: { status: 403, message: "the local owner is no longer active" },
  busy: { status: 409, message: "another local sign-in is setting up the workspace" },
} as const;

export function isLoopbackPeer(peer: string | undefined): boolean {
  const address = normalizeClientIp(peer);
  if (!address) return false;
  return address === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address);
}

export function localHostGuard(workspace: LocalWorkspace): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!localHostAllowed(c.req.header("host"), workspace.port))
      return c.json(
        {
          code: "misdirected_request",
          message: "this engine answers only on its loopback address",
        },
        421,
      );
    const origin = c.req.header("origin");
    if (
      MUTATING_METHODS.has(c.req.method) &&
      origin !== undefined &&
      origin !== `http://${c.req.header("host")}`
    )
      return c.json(
        { code: "csrf_rejected", message: "writes from another origin are not accepted" },
        403,
      );
    const capability = unavailableLocally(c.req.method, canonicalBrowserPath(c.req.raw));
    if (capability)
      return c.json(
        {
          code: "not_available_locally",
          capability,
          message:
            "this needs a server that the internet can reach; it is off in a local workspace",
        },
        409,
      );
    return await next();
  };
}

export function launcherRefusal(c: Context<AppEnv>, workspace: LocalWorkspace): Response | null {
  const peer = c.env?.incoming?.socket.remoteAddress;
  if (!isLoopbackPeer(peer))
    return c.json({ code: "loopback_only", message: "this route is loopback only" }, 403);
  if (c.req.header("sec-fetch-site") === "cross-site")
    return c.json({ code: "csrf_rejected", message: "cross-site requests are not allowed" }, 403);
  if (workspace.launchSecret === null)
    return c.json({ code: "launch_pending", message: "the engine is still starting" }, 503);
  if (!launchSecretMatches(workspace.launchSecret, c.req.header(LAUNCH_SECRET_HEADER))) {
    recordAuthFailure(c.get("client_ip") ?? "unknown");
    logger.warn({
      module: "auth",
      action: "local_workspace.secret_rejected",
      msg: "a launcher route presented no or a wrong launch secret",
    });
    return c.json({ code: "unauthorized", message: "the launch secret is not valid" }, 401);
  }
  return null;
}

export function registerLocalSessionRoute(
  app: OpenAPIHono<AppEnv>,
  workspace: LocalWorkspace,
): void {
  app.put(LOCAL_WORKSPACE_PATHS.power, async (c) => {
    const refused = launcherRefusal(c, workspace);
    if (refused) return refused;
    const parsed = LocalPowerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ code: "validation_failed", message: "invalid power state" }, 400);
    const deferred = parsed.data.on_battery || parsed.data.low_power_mode === true;
    workspace.power.defer(deferred);
    logger.info({
      module: "scheduler",
      action: "local_workspace.power",
      msg: deferred ? "background work waits for mains power" : "background work runs",
      on_battery: parsed.data.on_battery,
    });
    return c.json({ background_work: deferred ? "deferred" : "running" }, 200);
  });
  app.post(LOCAL_WORKSPACE_PATHS.session, async (c) => {
    const refused = launcherRefusal(c, workspace);
    if (refused) return refused;
    const parsed = LocalSessionRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ code: "validation_failed", message: "invalid local sign-in request" }, 400);
    const body = parsed.data;
    const db = c.get("db");
    const owner = await ensureLocalOwner(db, body.owner);
    if (!owner.ok) {
      const refusal = OWNER_REFUSALS[owner.code];
      return c.json({ code: owner.code, message: refusal.message }, refusal.status);
    }
    return await withContext(
      {
        tenant_id: owner.tenant_id,
        actor_id: owner.user_id,
        request_source: "ui",
        audit_origin_source: "ui",
        audit_execution_source: "ui",
      },
      async () => {
        const { installation, created } = await createOrReuseDesktopInstallation(
          db,
          owner.tenant_id,
          owner.user_id,
          { device_id: body.device_id, device_label: body.device_label },
        );
        const cockpitPath = `/cockpit/i/${installation.id}/`;
        const issued = await issueBrowserSession({
          db,
          tenantId: owner.tenant_id,
          userId: owner.user_id,
          installationId: installation.id,
          redirectTo: cockpitPath,
          via: "local_session",
          metadata: { installation_id: installation.id, kind: "desktop", created },
        });
        const cookie = issued.headers.get("set-cookie");
        if (issued.status !== 302 || !cookie)
          return c.json(
            { code: "session_issue_failed", message: "the session was not issued" },
            issued.status === 403 ? 403 : 500,
          );
        return c.json(
          {
            installation_id: installation.id,
            cockpit_path: cockpitPath,
            created,
            owner_created: owner.created,
          },
          200,
          { "set-cookie": cookie, "cache-control": "no-store" },
        );
      },
    );
  });
}
