import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import {
  allowedDesktopLoginCallbacks,
  browserSessionForPrincipal,
  consumeDesktopLoginCode,
  createDesktopLoginRateLimiter,
  DESKTOP_APP_OUTDATED,
  DESKTOP_LOGIN_CALLBACK,
  DESKTOP_LOGIN_CONFIRM_PATH,
  DESKTOP_LOGIN_START_PATH,
  DESKTOP_SESSION_PATH,
  type DesktopLoginCodeRejection,
  DesktopLoginStartQuerySchema,
  DesktopSessionRequestSchema,
  desktopAppVersionAccepted,
  desktopLoginCallbackFor,
  desktopLoginCallbackUrl,
  desktopMinVersion,
  findOwnedSession,
  isDesktopLoginCallbackUrl,
  issueBrowserSession,
  issueDesktopLoginCode,
  recordAuthFailure,
  signDesktopLoginConfirmation,
  signDesktopLoginRequest,
  signLoginState,
  verifyDesktopLoginConfirmation,
  verifyDesktopLoginRequest,
} from "../../../auth/index.ts";
import { getConfig } from "../../../config/loader.ts";
import { createOrReuseDesktopInstallation, findCockpitIdentity } from "../../../identity/index.ts";
import { logger, withContext } from "../../../logging/index.ts";
import type { AppEnv } from "../../openapi.ts";
import {
  createSharedRateLimiter,
  type SharedRateLimiter,
  type WindowLimit,
} from "../../rate-limits/persistent.ts";
import { escapeHtml, parseFormBody } from "../oauth/shared.ts";
import {
  authHtmlResponse,
  type PageLook,
  pageActions,
  pageHead,
  renderErrorPage,
  renderSinglePage,
  resolvePageLook,
} from "../oauth/ui.ts";

function loginLimiter(name: string, limits: WindowLimit): SharedRateLimiter {
  return createSharedRateLimiter({
    scope: "desktop_login",
    name,
    limits,
    local: createDesktopLoginRateLimiter(limits),
  });
}

const startLimiter = loginLimiter("start", { max: 30, windowMs: 60_000 });
const confirmLimiter = loginLimiter("confirm", { max: 30, windowMs: 60_000 });
const sessionLimiter = loginLimiter("session", { max: 10, windowMs: 60_000 });

const DesktopSessionResponse = z
  .object({
    installation_id: z.string().uuid(),
    cockpit_path: z
      .string()
      .describe("Same-origin path the desktop window loads; the session cookie is scoped to it."),
    created: z.boolean().describe("False when this device already had an active installation."),
  })
  .strict()
  .openapi("DesktopSessionResponse");

const startRoute = createRoute({
  method: "get",
  path: DESKTOP_LOGIN_START_PATH,
  tags: ["identity"],
  summary: "Start a SubKit Desktop sign-in in the system browser",
  description:
    "Opened by the desktop app in the system browser with a PKCE S256 challenge, a state and the device. The person signs in with the ordinary browser login and confirms the device; the browser is then sent to subkit://callback with a single-use code that lives for 60 seconds. A development build may name subkit-dev://callback as redirect_uri, which is accepted only outside production mode or with server.desktop_dev_callback. No other redirect target exists.",
  request: { query: DesktopLoginStartQuerySchema },
  responses: {
    302: {
      description: "Redirect to the confirmation page",
      headers: { Location: { schema: { type: "string" } } },
    },
    400: {
      description: "Invalid sign-in request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    426: {
      description:
        "The app is older than server.desktop_min_version or names no version; the page asks for an update and carries the code desktop_app_outdated in the X-SubKit-Error header",
      content: { "text/html": { schema: { type: "string" } } },
    },
    429: {
      description: "Too many sign-in starts",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const sessionRoute = createRoute({
  method: "post",
  path: DESKTOP_SESSION_PATH,
  tags: ["identity"],
  summary: "Exchange a desktop sign-in code for a Cockpit session",
  description:
    "Called by the desktop app's main process without a cookie. The code is single-use and bound to the PKCE challenge, the workspace, the person and the device; any attempt consumes it. The answer sets the HttpOnly Cockpit session cookie of the device's installation and never contains an API key.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: DesktopSessionRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Desktop installation with its session cookie",
      headers: { "Set-Cookie": { schema: { type: "string" } } },
      content: { "application/json": { schema: DesktopSessionResponse } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Code unknown, expired, already used or not matching the verifier",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Cross-origin browser request or unavailable workspace",
      content: { "application/json": { schema: ErrorSchema } },
    },
    426: {
      description:
        "The app is older than server.desktop_min_version or names no version (code desktop_app_outdated); the code is not consumed",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Too many exchanges",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Session could not be issued",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const ConfirmFormSchema = z.object({
  request: z.string().min(1).max(4096),
  csrf_token: z.string().min(1).max(4096),
  decision: z.enum(["approve", "deny"]),
});

function clientIp(c: Context<AppEnv>): string {
  return c.get("client_ip") ?? "unknown";
}

function tooManyRequests(c: Context<AppEnv>, retryAfterSeconds: number) {
  c.header("Retry-After", String(retryAfterSeconds));
  c.header("Cache-Control", "no-store");
  return c.json({ code: "rate_limit_exceeded", message: "too many requests" }, 429);
}

function publicOrigin(): string | null {
  try {
    return new URL(getConfig().server.public_base_url).origin;
  } catch {
    return null;
  }
}

function crossOriginBrowserRequest(c: Context<AppEnv>): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return true;
  const origin = c.req.header("origin");
  if (!origin) return false;
  return origin !== new URL(c.req.url).origin && origin !== publicOrigin();
}

async function rootBrowserSession(
  c: Context<AppEnv>,
): Promise<{ session_id: string; tenant_id: string; user_id: string } | null> {
  const principal = c.get("principal");
  if (principal?.provider !== "browser_session" || principal.kind !== "user") return null;
  const session = await browserSessionForPrincipal(c.req.raw, principal);
  if (!session || session.installation_id) return null;
  return { session_id: session.session_id, tenant_id: principal.tenant_id, user_id: principal.id };
}

function confirmPath(requestToken: string): string {
  return `${DESKTOP_LOGIN_CONFIRM_PATH}?request=${encodeURIComponent(requestToken)}`;
}

function expiredResponse(c: Context<AppEnv>): Response {
  return authHtmlResponse(
    renderErrorPage("state_expired", "/cockpit", resolvePageLook(c.req.raw.headers)),
    400,
  );
}

export function renderDesktopAppOutdated(opts: {
  appVersion: string | undefined;
  minVersion: string;
  look: PageLook;
}): string {
  const de = opts.look.locale === "de";
  const min = `<span class="strong">${escapeHtml(opts.minVersion)}</span>`;
  const line = opts.appVersion
    ? de
      ? `Auf diesem Gerät läuft Version ${escapeHtml(opts.appVersion)}. Dieser Arbeitsbereich nimmt Anmeldungen erst ab Version ${min} an.`
      : `This device runs version ${escapeHtml(opts.appVersion)}. This workspace accepts sign-ins from version ${min} on.`
    : de
      ? `Die App hat keine Version genannt. Dieser Arbeitsbereich nimmt Anmeldungen erst ab Version ${min} an.`
      : `The app did not name its version. This workspace accepts sign-ins from version ${min} on.`;
  const next = de
    ? "Aktualisiere SubKit Desktop und melde dich danach erneut an. Im Browser kannst du solange weiterarbeiten."
    : "Update SubKit Desktop, then sign in again. Until then you can keep working in the browser.";
  return renderSinglePage({
    look: opts.look,
    surface: "auth",
    context: "Desktop",
    body: `<div class="stack" role="alert" data-testid="desktop-login-outdated">${pageHead({ title: de ? "SubKit Desktop ist zu alt" : "SubKit Desktop is out of date", slot: "auth-heading", lineHtml: line })}<p class="muted">${next}</p></div>`,
  });
}

function outdatedResponse(c: Context<AppEnv>, appVersion: string | undefined): Response {
  const response = authHtmlResponse(
    renderDesktopAppOutdated({
      appVersion,
      minVersion: desktopMinVersion(),
      look: resolvePageLook(c.req.raw.headers),
    }),
    426,
  );
  response.headers.set("x-subkit-error", DESKTOP_APP_OUTDATED);
  response.headers.set("cache-control", "no-store");
  return response;
}

function callbackRedirect(target: string): Response {
  if (!isDesktopLoginCallbackUrl(target, allowedDesktopLoginCallbacks()))
    throw new Error("desktop sign-in callback target drifted");
  return new Response(null, {
    status: 303,
    headers: { location: target, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

export function renderDesktopLoginConfirm(opts: {
  deviceLabel: string;
  tenantName: string;
  userEmail: string;
  requestToken: string;
  csrfToken: string;
  look: PageLook;
}): string {
  const de = opts.look.locale === "de";
  const device = `<span class="strong">${escapeHtml(opts.deviceLabel)}</span>`;
  const tenant = `<span class="strong">${escapeHtml(opts.tenantName)}</span>`;
  const asks = de
    ? `SubKit Desktop auf ${device} möchte sich bei ${tenant} anmelden.`
    : `SubKit Desktop on ${device} is asking to sign in to ${tenant}.`;
  const signedIn = de ? "Angemeldet als" : "Signed in as";
  const caution = de
    ? "Fahre nur fort, wenn du diese Anmeldung gerade selbst in der App auf diesem Gerät gestartet hast."
    : "Continue only if you just started this sign-in yourself in the app on this device.";
  const hidden = `<input type="hidden" name="request" value="${escapeHtml(opts.requestToken)}"><input type="hidden" name="csrf_token" value="${escapeHtml(opts.csrfToken)}">`;
  return renderSinglePage({
    look: opts.look,
    surface: "auth",
    context: "Desktop",
    body: `${pageHead({ title: de ? "Bei SubKit Desktop anmelden" : "Sign in to SubKit Desktop", slot: "auth-heading", lineHtml: asks })}<p class="muted">${signedIn} ${escapeHtml(opts.userEmail)}</p><p class="muted">${caution}</p><form method="POST" action="${DESKTOP_LOGIN_CONFIRM_PATH}" data-testid="desktop-login-confirm">${hidden}${pageActions(`<button name="decision" value="deny" class="button outline">${de ? "Abbrechen" : "Cancel"}</button><button name="decision" value="approve" class="button primary">${de ? "Anmelden" : "Sign in"}</button>`)}</form>`,
  });
}

const REJECTION_STATUS: Record<DesktopLoginCodeRejection, 401 | 403> = {
  unknown_code: 401,
  replayed: 401,
  expired: 401,
  invalid_verifier: 401,
  state_mismatch: 401,
  user_inactive: 403,
};

export function registerDesktopLoginRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use(DESKTOP_LOGIN_START_PATH, async (c, next) => {
    const limit = await startLimiter.take(c.get("db"), clientIp(c));
    if (!limit.allowed) return tooManyRequests(c, limit.retry_after_seconds);
    return await next();
  });
  app.use(DESKTOP_SESSION_PATH, async (c, next) => {
    c.header("Cache-Control", "no-store");
    const limit = await sessionLimiter.take(c.get("db"), clientIp(c));
    if (!limit.allowed) return tooManyRequests(c, limit.retry_after_seconds);
    if (crossOriginBrowserRequest(c))
      return c.json(
        { code: "cross_origin_rejected", message: "this exchange is not open to web pages" },
        403,
      );
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json"))
      return c.json({ code: "bad_request", message: "the body must be application/json" }, 400);
    return await next();
  });

  app.openapi(startRoute, async (c) => {
    const query = c.req.valid("query");
    const callback = desktopLoginCallbackFor(query.redirect_uri, allowedDesktopLoginCallbacks());
    if (!callback)
      return c.json(
        { code: "invalid_redirect_uri", message: "this sign-in target is not accepted here" },
        400,
      );
    if (!desktopAppVersionAccepted(query.app_version, desktopMinVersion())) {
      logger.info({
        module: "auth",
        action: "desktop_login.outdated",
        msg: "desktop sign-in refused for an outdated app",
        device_id: query.device_id,
        app_version: query.app_version ?? null,
      });
      return outdatedResponse(c, query.app_version);
    }
    const requestToken = await signDesktopLoginRequest({
      code_challenge: query.code_challenge,
      state: query.state,
      device_id: query.device_id,
      device_label: query.device_label,
      app_version: query.app_version,
      ...(callback === DESKTOP_LOGIN_CALLBACK ? {} : { redirect_uri: callback }),
    });
    logger.info({
      module: "auth",
      action: "desktop_login.started",
      msg: "desktop sign-in started",
      device_id: query.device_id,
    });
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    return c.redirect(confirmPath(requestToken), 302);
  });

  app.get(DESKTOP_LOGIN_CONFIRM_PATH, async (c) => {
    const limit = await confirmLimiter.take(c.get("db"), clientIp(c));
    if (!limit.allowed) return tooManyRequests(c, limit.retry_after_seconds);
    const requestToken = c.req.query("request") ?? "";
    const request = await verifyDesktopLoginRequest(requestToken);
    if (!request) return expiredResponse(c);
    if (!desktopAppVersionAccepted(request.app_version, desktopMinVersion()))
      return outdatedResponse(c, request.app_version);
    const session = await rootBrowserSession(c);
    if (!session) {
      const loginState = await signLoginState({ redirect_to: confirmPath(requestToken) });
      return c.redirect(
        `/v1/identity/login/start?login_state=${encodeURIComponent(loginState)}`,
        302,
      );
    }
    const identity = await findCockpitIdentity(c.get("db"), session.tenant_id, session.user_id);
    if (!identity) return expiredResponse(c);
    return authHtmlResponse(
      renderDesktopLoginConfirm({
        deviceLabel: request.device_label,
        tenantName: identity.tenant_display_name,
        userEmail: identity.email,
        requestToken,
        csrfToken: await signDesktopLoginConfirmation(session.session_id, requestToken),
        look: resolvePageLook(c.req.raw.headers),
      }),
    );
  });

  app.post(DESKTOP_LOGIN_CONFIRM_PATH, async (c) => {
    const limit = await confirmLimiter.take(c.get("db"), clientIp(c));
    if (!limit.allowed) return tooManyRequests(c, limit.retry_after_seconds);
    if (c.req.header("sec-fetch-site") === "cross-site")
      return c.json({ code: "csrf_rejected", message: "cross-site form posts are refused" }, 403);
    const form = ConfirmFormSchema.safeParse(Object.fromEntries(await parseFormBody(c.req.raw)));
    if (!form.success) return expiredResponse(c);
    const request = await verifyDesktopLoginRequest(form.data.request);
    if (!request) return expiredResponse(c);
    const callback = desktopLoginCallbackFor(request.redirect_uri, allowedDesktopLoginCallbacks());
    if (!callback) return expiredResponse(c);
    if (!desktopAppVersionAccepted(request.app_version, desktopMinVersion()))
      return outdatedResponse(c, request.app_version);
    const session = await rootBrowserSession(c);
    if (!session) return c.redirect(confirmPath(form.data.request), 303);
    if (
      !(await verifyDesktopLoginConfirmation(
        form.data.csrf_token,
        session.session_id,
        form.data.request,
      ))
    )
      return c.json({ code: "csrf_rejected", message: "the confirmation is not valid" }, 403);
    const db = c.get("db");
    const device = { device_id: request.device_id, device_label: request.device_label };
    if (form.data.decision === "deny") {
      await auditAwait(
        {
          tenant_id: session.tenant_id,
          actor_type: "user",
          actor_id: session.user_id,
          action: AuditAction.DESKTOP_LOGIN_DENIED,
          resource_type: "user",
          resource_id: session.user_id,
          result: "denied",
          reason: "declined_by_user",
          metadata: device,
        },
        db,
      );
      return callbackRedirect(
        desktopLoginCallbackUrl({ error: "access_denied", state: request.state }, callback),
      );
    }
    const owned = await findOwnedSession(db, session);
    if (!owned) return c.redirect(confirmPath(form.data.request), 303);
    const issued = await issueDesktopLoginCode(db, {
      tenant_id: session.tenant_id,
      user_id: session.user_id,
      auth_identity_id: owned.auth_identity_id,
      request,
    });
    await auditAwait(
      {
        tenant_id: session.tenant_id,
        actor_type: "user",
        actor_id: session.user_id,
        action: AuditAction.DESKTOP_LOGIN_CODE_ISSUED,
        resource_type: "desktop_login_code",
        resource_id: issued.id,
        result: "success",
        metadata: { ...device, expires_at: issued.expires_at.toISOString() },
      },
      db,
    );
    return callbackRedirect(
      desktopLoginCallbackUrl({ code: issued.code, state: request.state }, callback),
    );
  });

  app.openapi(sessionRoute, async (c) => {
    const ip = clientIp(c);
    const body = c.req.valid("json");
    const db = c.get("db");
    if (!desktopAppVersionAccepted(body.app_version, desktopMinVersion()))
      return c.json(
        {
          code: DESKTOP_APP_OUTDATED,
          message: `this app is older than version ${desktopMinVersion()}; update it and sign in again`,
        },
        426,
      );
    const outcome = await consumeDesktopLoginCode(db, body);
    if (!outcome.ok) {
      recordAuthFailure(ip);
      const subject = outcome.subject;
      if (subject)
        await auditAwait(
          {
            tenant_id: subject.tenant_id,
            actor_type: "user",
            actor_id: subject.user_id,
            action: AuditAction.DESKTOP_LOGIN_DENIED,
            resource_type: "desktop_login_code",
            resource_id: subject.code_id,
            result: "denied",
            reason: outcome.reason,
            metadata: { device_id: subject.device_id },
          },
          db,
        );
      else
        logger.warn({
          module: "auth",
          action: "desktop_login.unknown_code",
          msg: "desktop sign-in exchange presented an unknown code",
          ip,
        });
      return c.json(
        {
          code: outcome.reason === "user_inactive" ? "user_inactive" : "invalid_grant",
          message: "the sign-in code is not valid",
        },
        REJECTION_STATUS[outcome.reason],
      );
    }
    const grant = outcome.grant;
    return await withContext(
      {
        tenant_id: grant.tenant_id,
        actor_id: grant.user_id,
        request_source: "ui",
        audit_origin_source: "ui",
        audit_execution_source: "ui",
      },
      async () => {
        const { installation, created } = await createOrReuseDesktopInstallation(
          db,
          grant.tenant_id,
          grant.user_id,
          { device_id: grant.device_id, device_label: grant.device_label },
        );
        const cockpitPath = `/cockpit/i/${installation.id}/`;
        const issued = await issueBrowserSession({
          db,
          tenantId: grant.tenant_id,
          userId: grant.user_id,
          ...(grant.auth_identity_id ? { authIdentityId: grant.auth_identity_id } : {}),
          installationId: installation.id,
          redirectTo: cockpitPath,
          via: "desktop_login",
          metadata: { installation_id: installation.id, kind: "desktop", created },
        });
        const cookie = issued.headers.get("set-cookie");
        if (issued.status !== 302 || !cookie) {
          const unavailable = issued.status === 403;
          return c.json(
            {
              code: unavailable ? "tenant_unavailable" : "session_issue_failed",
              message: unavailable ? "workspace is unavailable" : "the session was not issued",
            },
            unavailable ? 403 : 500,
          );
        }
        await auditAwait(
          {
            tenant_id: grant.tenant_id,
            actor_type: "user",
            actor_id: grant.user_id,
            action: AuditAction.DESKTOP_LOGIN_COMPLETED,
            resource_type: "cockpit_installation",
            resource_id: installation.id,
            result: "success",
            metadata: { device_id: grant.device_id, device_label: grant.device_label, created },
          },
          db,
        );
        return c.json(
          { installation_id: installation.id, cockpit_path: cockpitPath, created },
          200,
          {
            "set-cookie": cookie,
          },
        );
      },
    );
  });
}
