import { createHash, randomBytes } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import * as jose from "jose";
import * as oauth from "openid-client";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { getConfig, isConfigLoaded } from "../../config/loader.ts";
import { type Db, getDb } from "../../db/client.ts";
import { oidcLoginStates, roles, sessions, tenants, users } from "../../db/schema/index.ts";
import {
  authHtmlResponse,
  GRANT_DENIED_MESSAGE,
  renderErrorPage,
  SIGN_IN_FAILED_TITLE,
  STATE_ERROR_MESSAGE,
} from "../../http/routes/oauth/ui.ts";
import { logger } from "../../logging/logger.ts";
import { SESSION_ABSOLUTE_TTL_MS, SESSION_SLIDING_TTL_MS } from "../browser-session.ts";
import { resolveProviderIdentity, SignupDisabledError } from "../identity-link.ts";
import { createMcpOAuthProvider } from "../oauth/server-provider.ts";
import type { AuthProvider, ResolvedPrincipal } from "../types.ts";

const SESSION_COOKIE = "subkit_session";
const DEFAULT_TENANT_SLUG = "default";
const LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
const JWS_ALG = "HS256";
const LOGIN_START_PATH = "/v1/identity/login/start";

export interface OidcProviderOptions {
  providerId?: string;
  issuerUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  redirectUri?: string;
  tenantSlug?: string;
  db?: Db;
  sessionSecret?: Uint8Array;
  enableSignup?: boolean;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deriveSessionSecret(override?: Uint8Array): Uint8Array {
  if (override) return override;
  let fromConfig = "";
  try {
    fromConfig = (getConfig().auth.session.secret ?? "").trim();
  } catch {}
  if (fromConfig.length > 0) {
    return new TextEncoder().encode(fromConfig);
  }
  const masterKey = process.env.MASTER_KEY ?? "";
  return new Uint8Array(createHash("sha256").update(`${masterKey}:session`).digest());
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

async function loadConfig(
  issuerUrl: string,
  clientId: string,
  clientSecret: string | undefined,
): Promise<oauth.Configuration> {
  const url = new URL(issuerUrl);
  if (url.protocol === "http:") {
    if (process.env.NODE_ENV === "production") {
      logger.warn({
        msg: "OIDC issuer uses insecure HTTP — authorization codes may be intercepted",
        issuer: issuerUrl,
      });
    }
  }
  const discoveryOptions: oauth.DiscoveryRequestOptions =
    url.protocol === "http:" ? { execute: [oauth.allowInsecureRequests] } : {};
  const configuration = await oauth.discovery(
    url,
    clientId,
    clientSecret,
    undefined,
    discoveryOptions,
  );
  if (url.protocol === "http:") {
    oauth.allowInsecureRequests(configuration);
  }
  return configuration;
}

async function signSessionCookie(
  secret: Uint8Array,
  payload: { session_id: string; user_id: string; tenant_id: string },
): Promise<string> {
  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: JWS_ALG })
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() + SESSION_ABSOLUTE_TTL_MS) / 1000))
    .sign(secret);
}

async function verifySessionCookie(
  secret: Uint8Array,
  jwt: string,
): Promise<{ session_id: string; user_id: string; tenant_id: string } | null> {
  try {
    const { payload } = await jose.jwtVerify(jwt, secret);
    const session_id = typeof payload.session_id === "string" ? payload.session_id : null;
    const user_id = typeof payload.user_id === "string" ? payload.user_id : null;
    const tenant_id = typeof payload.tenant_id === "string" ? payload.tenant_id : null;
    if (!session_id || !user_id || !tenant_id) return null;
    return { session_id, user_id, tenant_id };
  } catch {
    return null;
  }
}

function buildCookieHeader(jwt: string): string {
  const maxAge = Math.floor(SESSION_ABSOLUTE_TTL_MS / 1000);
  const secure = process.env.NODE_ENV !== "development" ? " Secure;" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(
    jwt,
  )}; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=${maxAge}`;
}

function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function httpError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function wantsJson(req: Request): boolean {
  return (req.headers.get("accept") ?? "").includes("application/json");
}

function browserError(
  req: Request,
  status: number,
  code: string,
  message: string,
  pageMessage: string,
  retryHref: string,
): Response {
  if (wantsJson(req)) return httpError(status, code, message);
  return authHtmlResponse(renderErrorPage(SIGN_IN_FAILED_TITLE, pageMessage, retryHref), status);
}

async function redirectDenialToClient(
  exec: Db,
  redirectTo: string | null,
): Promise<Response | null> {
  if (!redirectTo) return null;
  try {
    const authorizeUrl = new URL(redirectTo);
    if (!authorizeUrl.pathname.endsWith("/v1/oauth/authorize")) return null;
    const clientId = authorizeUrl.searchParams.get("client_id");
    const clientRedirect = authorizeUrl.searchParams.get("redirect_uri");
    if (!clientId || !clientRedirect) return null;
    const client = await createMcpOAuthProvider({ db: exec, config: getConfig() }).getClient(
      clientId,
    );
    if (!client?.redirect_uris.includes(clientRedirect)) return null;
    const target = new URL(clientRedirect);
    target.searchParams.set("error", "access_denied");
    const clientState = authorizeUrl.searchParams.get("state");
    if (clientState) target.searchParams.set("state", clientState);
    return new Response(null, {
      status: 302,
      headers: { location: target.toString(), "cache-control": "no-store" },
    });
  } catch {
    return null;
  }
}

function isSafeRedirect(url: string, baseUrl: string): boolean {
  if (!url) return false;
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  try {
    const target = new URL(url);
    const base = new URL(baseUrl);
    return target.origin === base.origin;
  } catch {
    return false;
  }
}

async function resolveTenantId(db: Db, slug: string | null): Promise<string | null> {
  const lookupSlug = slug ?? DEFAULT_TENANT_SLUG;
  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, lookupSlug))
    .limit(1);
  return rows[0]?.id ?? null;
}

export function createOidcProvider(opts: OidcProviderOptions = {}): AuthProvider {
  let configured:
    | {
        id: string;
        issuer_url: string;
        client_id: string;
        scopes: string;
        tenant_slug: string;
      }
    | undefined;
  let configuredRedirectUri = "";
  try {
    const config = getConfig();
    configured = config.auth.providers.find((provider) => provider.protocol === "oidc");
    configuredRedirectUri = `${config.server.public_base_url}/v1/identity/login/callback`;
  } catch {}
  const issuerUrl = opts.issuerUrl ?? configured?.issuer_url ?? "";
  const clientId = opts.clientId ?? configured?.client_id ?? "";
  const clientSecretInput = opts.clientSecret;
  const scopes = opts.scopes ?? configured?.scopes ?? "openid profile email";
  const redirectUri = opts.redirectUri ?? configuredRedirectUri;
  const configuredTenantSlug = opts.tenantSlug ?? configured?.tenant_slug ?? DEFAULT_TENANT_SLUG;
  const sessionSecret = deriveSessionSecret(opts.sessionSecret);
  const providerId = opts.providerId?.trim() || configured?.id;
  const adapterId = providerId ?? "oidc";
  const db = opts.db;

  function getExec(): Db {
    return db ?? getDb();
  }

  function signupEnabled(): boolean {
    if (opts.enableSignup !== undefined) return opts.enableSignup;
    return isConfigLoaded() ? getConfig().auth.enable_signup : false;
  }

  return {
    name: adapterId,
    capabilities: {
      human: true,
      machine: false,
      interactive: true,
      refresh: true,
      revoke: true,
    },

    async startLogin(req: Request): Promise<Response> {
      if (!issuerUrl || !clientId || !redirectUri) {
        return browserError(
          req,
          500,
          "oidc_not_configured",
          "oidc provider not configured",
          "This sign-in provider is not configured. Contact the operator.",
          LOGIN_START_PATH,
        );
      }
      const url = new URL(req.url);
      const tenantSlug = url.searchParams.get("tenant") ?? configuredTenantSlug;
      const redirectTo = url.searchParams.get("redirect_to");
      const exec = getExec();

      const tenantId = await resolveTenantId(exec, tenantSlug);
      if (!tenantId) {
        return browserError(
          req,
          400,
          "unknown_tenant",
          "tenant not found",
          "This sign-in provider is not available for this tenant. Please sign in again.",
          LOGIN_START_PATH,
        );
      }

      let configuration: oauth.Configuration;
      try {
        configuration = await loadConfig(issuerUrl, clientId, clientSecretInput);
      } catch (err) {
        logger.error({
          module: "auth",
          action: "oidc.discovery_failed",
          msg: "oidc discovery failed",
          error: err instanceof Error ? err.message : String(err),
        });
        return browserError(
          req,
          502,
          "oidc_discovery_failed",
          "issuer discovery failed",
          "The sign-in provider is temporarily unavailable. Please try again.",
          LOGIN_START_PATH,
        );
      }

      const code_verifier = oauth.randomPKCECodeVerifier();
      const code_challenge = await oauth.calculatePKCECodeChallenge(code_verifier);
      const state = providerId ? `${providerId}.${oauth.randomState()}` : oauth.randomState();
      const nonce = oauth.randomNonce();

      await exec.insert(oidcLoginStates).values({
        tenant_id: tenantId,
        state,
        code_verifier,
        nonce,
        redirect_to: redirectTo ?? null,
        expires_at: new Date(Date.now() + LOGIN_STATE_TTL_MS),
      });

      const authUrl = oauth.buildAuthorizationUrl(configuration, {
        redirect_uri: redirectUri,
        scope: scopes,
        state,
        nonce,
        code_challenge,
        code_challenge_method: "S256",
      });

      return Response.redirect(authUrl.toString(), 302);
    },

    async finishLogin(req: Request): Promise<Response> {
      if (!issuerUrl || !clientId || !redirectUri) {
        return browserError(
          req,
          500,
          "oidc_not_configured",
          "oidc provider not configured",
          "This sign-in provider is not configured. Contact the operator.",
          LOGIN_START_PATH,
        );
      }
      const reqUrl = new URL(req.url);
      const state = reqUrl.searchParams.get("state");
      if (!state) {
        return browserError(
          req,
          400,
          "missing_state",
          "state parameter missing",
          STATE_ERROR_MESSAGE,
          LOGIN_START_PATH,
        );
      }
      const exec = getExec();

      void exec
        .delete(oidcLoginStates)
        .where(lt(oidcLoginStates.expires_at, new Date()))
        .catch(() => {});

      const pending = await exec.transaction(async (tx) => {
        // tenant-filter:exempt — OIDC issuer/sub lookup pre-tenant
        const rows = await tx
          .select()
          .from(oidcLoginStates)
          .where(eq(oidcLoginStates.state, state))
          .limit(1);
        const row = rows[0];
        if (!row) return null;
        await tx.delete(oidcLoginStates).where(eq(oidcLoginStates.id, row.id));
        return row;
      });

      if (!pending) {
        return browserError(
          req,
          400,
          "unknown_state",
          "state not recognised",
          STATE_ERROR_MESSAGE,
          LOGIN_START_PATH,
        );
      }
      const retryHref =
        pending.redirect_to && isSafeRedirect(pending.redirect_to, redirectUri)
          ? pending.redirect_to
          : LOGIN_START_PATH;
      if (pending.expires_at.getTime() < Date.now()) {
        return browserError(
          req,
          400,
          "expired_state",
          "login state expired",
          STATE_ERROR_MESSAGE,
          retryHref,
        );
      }

      const idpError = reqUrl.searchParams.get("error");
      if (idpError) {
        logger.warn({
          module: "auth",
          action: "oidc.provider_error",
          msg: "identity provider returned an authorization error",
          error: idpError,
        });
        if (idpError === "access_denied") {
          const clientRedirect = await redirectDenialToClient(exec, pending.redirect_to);
          if (clientRedirect) return clientRedirect;
          return browserError(
            req,
            403,
            "access_denied",
            "the identity provider denied the grant",
            GRANT_DENIED_MESSAGE,
            retryHref,
          );
        }
        return browserError(
          req,
          502,
          "oidc_provider_error",
          `identity provider returned ${idpError}`,
          STATE_ERROR_MESSAGE,
          retryHref,
        );
      }

      if (!pending.tenant_id) {
        return httpError(400, "tenant_missing", "pending login missing tenant");
      }
      const tenantId = pending.tenant_id;

      let configuration: oauth.Configuration;
      try {
        configuration = await loadConfig(issuerUrl, clientId, clientSecretInput);
      } catch (err) {
        logger.error({
          module: "auth",
          action: "oidc.discovery_failed",
          msg: "oidc discovery failed",
          error: err instanceof Error ? err.message : String(err),
        });
        return browserError(
          req,
          502,
          "oidc_discovery_failed",
          "issuer discovery failed",
          "The sign-in provider is temporarily unavailable. Please try again.",
          retryHref,
        );
      }

      let tokens: oauth.TokenEndpointResponse & oauth.TokenEndpointResponseHelpers;
      try {
        const callbackUrl = new URL(redirectUri);
        callbackUrl.search = reqUrl.search;
        tokens = await oauth.authorizationCodeGrant(configuration, callbackUrl, {
          expectedState: pending.state,
          expectedNonce: pending.nonce,
          pkceCodeVerifier: pending.code_verifier,
        });
      } catch (err) {
        logger.warn({
          module: "auth",
          action: "oidc.code_exchange_failed",
          msg: "authorization code grant failed",
          error: err instanceof Error ? err.message : String(err),
        });
        return browserError(
          req,
          401,
          "oidc_code_exchange_failed",
          "token exchange failed",
          STATE_ERROR_MESSAGE,
          retryHref,
        );
      }

      const claims = tokens.claims();
      const sub = typeof claims?.sub === "string" ? claims.sub : null;
      if (!sub) {
        return httpError(401, "oidc_missing_sub", "id_token missing sub");
      }
      const rawEmail = (claims as { email?: unknown } | undefined)?.email;
      const emailVerified =
        (claims as { email_verified?: unknown } | undefined)?.email_verified === true;
      const email =
        emailVerified && typeof rawEmail === "string" && rawEmail.length > 0
          ? rawEmail
          : `${adapterId}:${sub}@invalid`;
      let userRow: Awaited<ReturnType<typeof resolveProviderIdentity>>["user"];
      let createdUser: boolean;
      let linkedIdentity: boolean;
      try {
        ({
          user: userRow,
          createdUser,
          linkedIdentity,
        } = await resolveProviderIdentity(exec, {
          tenantId,
          providerId: adapterId,
          subject: sub,
          email,
          linkByEmail: emailVerified,
          allowCreate: signupEnabled(),
        }));
      } catch (err) {
        if (err instanceof SignupDisabledError) {
          logger.warn({
            module: "auth",
            action: "oidc.signup_disabled",
            msg: "SSO login rejected — signups disabled and identity matches no existing account",
            provider_id: adapterId,
            subject: sub,
          });
          const clientRedirect = await redirectDenialToClient(exec, pending.redirect_to);
          if (clientRedirect) return clientRedirect;
          return browserError(
            req,
            403,
            "access_denied",
            "signups are disabled and this identity matches no existing account",
            GRANT_DENIED_MESSAGE,
            retryHref,
          );
        }
        throw err;
      }
      if (userRow.deleted_at !== null || userRow.status !== "active") {
        return browserError(
          req,
          403,
          "user_inactive",
          "user is not active",
          GRANT_DENIED_MESSAGE,
          retryHref,
        );
      }

      const rawNonce = randomBytes(32).toString("hex");
      const tokenHash = sha256Hex(rawNonce);
      const now = new Date();
      const [sessionRow] = await exec
        .insert(sessions)
        .values({
          tenant_id: tenantId,
          user_id: userRow.id,
          expires_at: new Date(now.getTime() + SESSION_SLIDING_TTL_MS),
          absolute_expires_at: new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS),
          last_seen_at: now,
          token_sha256: tokenHash,
        })
        .returning();
      if (!sessionRow) {
        return httpError(500, "session_insert_failed", "failed to create session");
      }

      const jwt = await signSessionCookie(sessionSecret, {
        session_id: sessionRow.id,
        user_id: userRow.id,
        tenant_id: tenantId,
      });

      if (createdUser) {
        await auditAwait(
          {
            tenant_id: tenantId,
            actor_type: "system",
            actor_id: null,
            action: AuditAction.USER_CREATED,
            resource_type: "user",
            resource_id: userRow.id,
            result: "success",
            metadata: { sub, email, source: "oidc_login" },
          },
          exec,
        );
      }
      if (linkedIdentity) {
        await auditAwait(
          {
            tenant_id: tenantId,
            actor_type: "system",
            actor_id: null,
            action: AuditAction.USER_IDENTITY_LINKED,
            resource_type: "user",
            resource_id: userRow.id,
            result: "success",
            metadata: { source: adapterId, subject: sub, email },
          },
          exec,
        );
      }
      await auditAwait(
        {
          tenant_id: tenantId,
          actor_type: "user",
          actor_id: userRow.id,
          action: AuditAction.SESSION_ISSUED,
          resource_type: "session",
          resource_id: sessionRow.id,
          result: "success",
          metadata: { sub, issuer: issuerUrl, via: "oidc_auth_code" },
        },
        exec,
      );
      await auditAwait(
        {
          tenant_id: tenantId,
          actor_type: "user",
          actor_id: userRow.id,
          action: AuditAction.USER_LOGGED_IN,
          resource_type: "user",
          resource_id: userRow.id,
          result: "success",
          metadata: { sub, issuer: issuerUrl },
        },
        exec,
      );

      const rawTarget = pending.redirect_to ?? null;
      const target = rawTarget && isSafeRedirect(rawTarget, redirectUri) ? rawTarget : "/";
      const res = new Response(null, {
        status: 302,
        headers: {
          location: target,
          "set-cookie": buildCookieHeader(jwt),
        },
      });
      return res;
    },

    async resolve(req: Request): Promise<ResolvedPrincipal | null> {
      const cookies = parseCookies(req.headers.get("cookie"));
      const jwt = cookies[SESSION_COOKIE];
      if (!jwt) return null;

      const payload = await verifySessionCookie(sessionSecret, jwt);
      if (!payload) return null;

      const exec = getExec();
      // tenant-filter:exempt — OIDC issuer/sub lookup pre-tenant
      const rows = await exec
        .select()
        .from(sessions)
        .where(eq(sessions.id, payload.session_id))
        .limit(1);
      const row = rows[0];
      if (!row) return null;

      const now = new Date();

      let denyReason: "revoked" | "expired_absolute" | "expired_sliding" | null = null;
      if (row.revoked_at) {
        denyReason = "revoked";
      } else if (row.absolute_expires_at && row.absolute_expires_at.getTime() <= now.getTime()) {
        denyReason = "expired_absolute";
      } else if (
        row.last_seen_at &&
        now.getTime() - row.last_seen_at.getTime() > SESSION_SLIDING_TTL_MS
      ) {
        denyReason = "expired_sliding";
      }

      if (denyReason) {
        await auditAwait(
          {
            tenant_id: row.tenant_id,
            actor_type: "system",
            actor_id: row.user_id,
            action: AuditAction.SESSION_REVOKED,
            resource_type: "session",
            resource_id: row.id,
            result: "denied",
            reason: denyReason,
            metadata: { via: "oidc_resolve" },
          },
          exec,
        );
        return null;
      }

      void Promise.resolve().then(() => {
        exec
          .update(sessions)
          .set({ last_seen_at: new Date() })
          .where(eq(sessions.id, row.id))
          .catch((err) => {
            logger.warn({
              module: "auth",
              action: "oidc.last_seen_flush_failed",
              msg: "failed to bump sessions.last_seen_at",
              session_id: row.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      });

      // tenant-filter:exempt — OIDC issuer/sub lookup pre-tenant
      const userRows = await exec
        .select({ role_name: roles.name, email: users.email })
        .from(users)
        .leftJoin(roles, eq(roles.id, users.role_id))
        .where(eq(users.id, row.user_id))
        .limit(1);
      const u = userRows[0];
      if (!u) return null;

      const principal: ResolvedPrincipal = {
        provider: "oidc",
        kind: "user",
        id: row.user_id,
        tenant_id: row.tenant_id,
        roles: u.role_name ? [u.role_name] : [],
        session_id: row.id,
      };
      if (u.email) principal.email = u.email;
      return principal;
    },

    async revoke(req: Request): Promise<Response> {
      const cookies = parseCookies(req.headers.get("cookie"));
      const jwt = cookies[SESSION_COOKIE];
      if (!jwt) {
        return new Response(null, {
          status: 204,
          headers: { "set-cookie": clearCookieHeader() },
        });
      }
      const payload = await verifySessionCookie(sessionSecret, jwt);
      if (!payload) {
        return new Response(null, {
          status: 204,
          headers: { "set-cookie": clearCookieHeader() },
        });
      }
      const exec = getExec();
      const [row] = await exec
        .update(sessions)
        .set({ revoked_at: new Date() })
        .where(eq(sessions.id, payload.session_id))
        .returning();
      if (row) {
        await auditAwait(
          {
            tenant_id: row.tenant_id,
            actor_type: "user",
            actor_id: row.user_id,
            action: AuditAction.SESSION_REVOKED,
            resource_type: "session",
            resource_id: row.id,
            result: "success",
            reason: "user_logout",
            metadata: { via: "oidc_logout" },
          },
          exec,
        );
        await auditAwait(
          {
            tenant_id: row.tenant_id,
            actor_type: "user",
            actor_id: row.user_id,
            action: AuditAction.USER_LOGGED_OUT,
            resource_type: "user",
            resource_id: row.user_id,
            result: "success",
            metadata: { via: "oidc_logout" },
          },
          exec,
        );
      }
      return new Response(null, {
        status: 204,
        headers: { "set-cookie": clearCookieHeader() },
      });
    },
  };
}
