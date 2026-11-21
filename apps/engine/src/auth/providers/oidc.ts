import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import * as oauth from "openid-client";
import { ZodError } from "zod";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { getConfig, isConfigLoaded } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { oidcLoginStates, sessions, tenants } from "../../db/schema/index.ts";
import { readEnv } from "../../env.ts";
import {
  acceptVerifiedMembershipInvite,
  assertTenantActive,
  clearPendingRegistrationCookie,
  endCockpitPushForSessions,
  IdentityRecoveryError,
  INVITE_PAGE_PATH,
  issueIdentityRecovery,
  issuePendingRegistration,
  MembershipInviteError,
  REGISTRATION_REDIRECT_MAX,
  resolveHostedIdentity,
  SelfServiceIdentityError,
} from "../../identity/index.ts";
import { logger } from "../../logging/index.ts";
import {
  issueBrowserSession,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_SLIDING_TTL_MS,
} from "../browser-session.ts";
import {
  IdentityLinkConflictError,
  resolveProviderIdentity,
  SignupDisabledError,
} from "../identity-link.ts";
import type { AuthProvider } from "../types.ts";
import { loadOidcConfiguration } from "./oidc-discovery.ts";
import {
  findActiveCockpitInstallation,
  findActiveCockpitInstallationForTenant,
  findCockpitInstallationIdentity,
} from "./oidc-installation.ts";
import {
  browserError,
  isSafeRedirect,
  LOGIN_START_PATH,
  redirectDenialToClient,
  tenantMismatchResponse,
  wantsJson,
} from "./oidc-responses.ts";
import {
  accountChoiceCookie,
  accountChoiceRequested,
  buildCookieHeader,
  clearCookieHeader,
  deriveSessionSecret,
  parseCookies,
  purgeExpiredOidcLoginStates,
  resolveOidcSession,
  SESSION_COOKIE,
  sha256Hex,
  signSessionCookie,
  verifySessionCookie,
} from "./oidc-session.ts";

const DEFAULT_TENANT_SLUG = "default";
const LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
const RECOVERY_LOGIN_COOKIE = "subkit_recovery_login";

export interface OidcProviderOptions {
  providerId?: string;
  issuerUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  redirectUri?: string;
  tenantSlug?: string;
  productId?: string;
  linkByEmail?: boolean;
  db: Db;
  sessionSecret?: Uint8Array;
  enableSignup?: boolean;
  signupPolicy?: "existing_tenant" | "invite_only" | "self_service";
  membershipInviteId?: string;
  installationId?: string;
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

export function createOidcProvider(opts: OidcProviderOptions): AuthProvider {
  let configured:
    | {
        id: string;
        issuer_url: string;
        client_id: string;
        scopes: string;
        tenant_slug: string;
        product_id?: string | undefined;
        link_by_email?: boolean | undefined;
        signup_policy?: "existing_tenant" | "invite_only" | "self_service" | undefined;
      }
    | undefined;
  let configuredRedirectUri = "";
  try {
    const config = getConfig();
    const selectedId = opts.providerId?.trim();
    configured = config.auth.providers
      .filter((provider) => provider.protocol === "oidc")
      .find((provider) => !selectedId || provider.id === selectedId);
    configuredRedirectUri = `${config.server.public_base_url}/v1/identity/login/callback`;
  } catch {}
  const issuerUrl = opts.issuerUrl ?? configured?.issuer_url ?? "";
  const clientId = opts.clientId ?? configured?.client_id ?? "";
  const clientSecretInput = opts.clientSecret;
  const scopes = opts.scopes ?? configured?.scopes ?? "openid profile email";
  const redirectUri = opts.redirectUri ?? configuredRedirectUri;
  const configuredTenantSlug = opts.tenantSlug ?? configured?.tenant_slug ?? DEFAULT_TENANT_SLUG;
  const productId = opts.productId ?? configured?.product_id;
  const sessionSecret = deriveSessionSecret(opts.sessionSecret);
  const providerId = opts.providerId?.trim() || configured?.id;
  const adapterId = providerId ?? "oidc";
  const db = opts.db;

  const signupPolicy = opts.signupPolicy ?? configured?.signup_policy;
  const hostedSignup = signupPolicy === "self_service";

  function signupEnabled(): boolean {
    if (productId || signupPolicy === "invite_only" || hostedSignup) return false;
    if (signupPolicy === "existing_tenant") return true;
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
          "provider_not_configured",
          LOGIN_START_PATH,
        );
      }
      const url = new URL(req.url);
      if (hostedSignup && (!isConfigLoaded() || !getConfig().auth.hosted.enabled || productId)) {
        return browserError(
          req,
          403,
          "hosted_signup_disabled",
          "hosted signup is not enabled",
          "provider_not_configured",
          LOGIN_START_PATH,
        );
      }
      const requestedTenantSlug = url.searchParams.get("tenant");
      if (
        !hostedSignup &&
        !opts.installationId &&
        requestedTenantSlug !== null &&
        requestedTenantSlug !== configuredTenantSlug
      )
        return tenantMismatchResponse(req);
      const redirectTo = url.searchParams.get("redirect_to");
      if (hostedSignup && redirectTo && redirectTo.length > REGISTRATION_REDIRECT_MAX) {
        return browserError(
          req,
          400,
          "redirect_too_long",
          "the sign-in destination is too long to carry through a registration",
          "state_expired",
          LOGIN_START_PATH,
        );
      }
      const chooseAccount = accountChoiceRequested(req);
      const exec = db;
      let installation = null;
      if (opts.installationId) {
        installation = await findActiveCockpitInstallation(exec, opts.installationId);
        if (!installation) {
          return browserError(
            req,
            404,
            "installation_not_found",
            "Cockpit installation not found",
            "account_not_assigned",
            LOGIN_START_PATH,
          );
        }
        if (requestedTenantSlug !== null) {
          if ((await resolveTenantId(exec, requestedTenantSlug)) !== installation.tenant_id)
            return tenantMismatchResponse(req);
        }
      }
      const tenantId =
        installation?.tenant_id ??
        (hostedSignup ? null : await resolveTenantId(exec, configuredTenantSlug));
      if (!tenantId && !hostedSignup) {
        return browserError(
          req,
          400,
          "unknown_tenant",
          "tenant not found",
          "tenant_unavailable",
          LOGIN_START_PATH,
        );
      }
      let configuration: oauth.Configuration;
      try {
        configuration = await loadOidcConfiguration(issuerUrl, clientId, clientSecretInput);
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
          "provider_unavailable",
          LOGIN_START_PATH,
        );
      }

      const code_verifier = oauth.randomPKCECodeVerifier();
      const code_challenge = await oauth.calculatePKCECodeChallenge(code_verifier);
      const state = providerId ? `${providerId}.${oauth.randomState()}` : oauth.randomState();
      const nonce = oauth.randomNonce();

      purgeExpiredOidcLoginStates(exec);

      await exec.insert(oidcLoginStates).values({
        tenant_id: tenantId,
        membership_invite_id: opts.membershipInviteId ?? null,
        installation_id: installation?.id ?? null,
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
        ...(hostedSignup && redirectTo === "/v1/identity/recovery"
          ? { prompt: "login", max_age: "0" }
          : chooseAccount
            ? { prompt: "select_account" }
            : {}),
      });

      if (hostedSignup && redirectTo === "/v1/identity/recovery") {
        const secure = readEnv("NODE_ENV") !== "development" ? "; Secure" : "";
        return new Response(null, {
          status: 302,
          headers: {
            location: authUrl.toString(),
            "set-cookie": `${RECOVERY_LOGIN_COOKIE}=${encodeURIComponent(state)}; Path=/v1/identity/login/callback; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
            "cache-control": "no-store",
          },
        });
      }
      if (chooseAccount) {
        return new Response(null, {
          status: 302,
          headers: {
            location: authUrl.toString(),
            "set-cookie": accountChoiceCookie(false),
            "cache-control": "no-store",
          },
        });
      }
      return Response.redirect(authUrl.toString(), 302);
    },

    async finishLogin(req: Request): Promise<Response> {
      if (!issuerUrl || !clientId || !redirectUri) {
        return browserError(
          req,
          500,
          "oidc_not_configured",
          "oidc provider not configured",
          "provider_not_configured",
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
          "state_expired",
          LOGIN_START_PATH,
        );
      }
      const exec = db;

      purgeExpiredOidcLoginStates(exec);

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
          "state_expired",
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
          "state_expired",
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
            "grant_denied",
            retryHref,
          );
        }
        return browserError(
          req,
          502,
          "oidc_provider_error",
          `identity provider returned ${idpError}`,
          "state_expired",
          retryHref,
        );
      }

      if (!pending.tenant_id && !hostedSignup) {
        return browserError(
          req,
          400,
          "tenant_missing",
          "pending login missing tenant",
          "tenant_unavailable",
          retryHref,
        );
      }
      const tenantId = pending.tenant_id;
      if (hostedSignup && pending.redirect_to === "/v1/identity/recovery") {
        const browserState = parseCookies(req.headers.get("cookie"))[RECOVERY_LOGIN_COOKIE];
        if (!browserState || sha256Hex(browserState) !== sha256Hex(pending.state)) {
          return browserError(
            req,
            403,
            "recovery_browser_binding_required",
            "restart recovery sign-in in this browser",
            "state_expired",
            retryHref,
          );
        }
      }

      let configuration: oauth.Configuration;
      try {
        configuration = await loadOidcConfiguration(issuerUrl, clientId, clientSecretInput);
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
          "provider_unavailable",
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
          "state_expired",
          retryHref,
        );
      }

      const claims = tokens.claims();
      const sub = typeof claims?.sub === "string" ? claims.sub : null;
      if (!sub) {
        return browserError(
          req,
          401,
          "oidc_missing_sub",
          "id_token missing sub",
          "grant_denied",
          retryHref,
        );
      }
      const rawEmail = (claims as { email?: unknown } | undefined)?.email;
      const emailVerified =
        (claims as { email_verified?: unknown } | undefined)?.email_verified === true;
      if (pending.installation_id) {
        if (!pending.tenant_id) {
          return browserError(
            req,
            403,
            "installation_unavailable",
            "Cockpit installation is unavailable",
            "account_not_assigned",
            retryHref,
          );
        }
        const installation = await findActiveCockpitInstallationForTenant(
          exec,
          pending.installation_id,
          pending.tenant_id,
        );
        if (!installation) {
          return browserError(
            req,
            403,
            "installation_unavailable",
            "Cockpit installation is unavailable",
            "account_not_assigned",
            retryHref,
          );
        }
        const identity = await findCockpitInstallationIdentity(exec, {
          installationId: pending.installation_id,
          tenantId: pending.tenant_id,
          providerId: adapterId,
          subject: sub,
          issuerUrl,
          ...(productId !== undefined ? { productId } : {}),
        });
        if (!identity) {
          return browserError(
            req,
            403,
            "installation_identity_mismatch",
            "this identity cannot access the Cockpit installation",
            "account_not_assigned",
            retryHref,
          );
        }
        const target = pending.redirect_to;
        if (!target?.startsWith(`/cockpit/i/${installation.id}/`)) {
          return browserError(
            req,
            400,
            "installation_redirect_invalid",
            "Cockpit installation redirect is invalid",
            "state_expired",
            retryHref,
          );
        }
        return await issueBrowserSession({
          db: exec,
          tenantId: identity.tenant_id,
          userId: identity.owner_user_id,
          ...(identity.auth_identity_id ? { authIdentityId: identity.auth_identity_id } : {}),
          installationId: identity.id,
          redirectTo: target,
          via: "oidc_cockpit_installation",
          metadata: { provider_id: adapterId, installation_id: identity.id },
        });
      }
      if (hostedSignup) {
        if (!isConfigLoaded() || !getConfig().auth.hosted.enabled || productId) {
          return browserError(
            req,
            403,
            "hosted_signup_disabled",
            "hosted signup is not enabled",
            "provider_not_configured",
            retryHref,
          );
        }
        if (!emailVerified || typeof rawEmail !== "string" || rawEmail.length === 0) {
          return browserError(
            req,
            403,
            "verified_email_required",
            "a verified email is required",
            "grant_denied",
            retryHref,
          );
        }
        try {
          if (pending.redirect_to === "/v1/identity/recovery" && !pending.membership_invite_id) {
            const authTime = claims?.auth_time;
            if (
              typeof authTime !== "number" ||
              !Number.isFinite(authTime) ||
              authTime * 1000 < pending.created_at.getTime() - 30_000 ||
              Date.now() - authTime * 1000 > 5 * 60_000 ||
              authTime * 1000 > Date.now() + 30_000
            ) {
              return browserError(
                req,
                403,
                "reauthentication_required",
                "the identity provider must confirm a fresh sign-in",
                "grant_denied",
                retryHref,
              );
            }
            return await issueIdentityRecovery(
              { issuer_url: issuerUrl, subject: sub, email: rawEmail, email_verified: true },
              exec,
            );
          }
          const verified = {
            issuer_url: issuerUrl,
            subject: sub,
            email: rawEmail,
            email_verified: true as const,
          };
          const redirectTo =
            pending.redirect_to && isSafeRedirect(pending.redirect_to, redirectUri)
              ? pending.redirect_to
              : null;
          const resolved = pending.membership_invite_id
            ? await acceptVerifiedMembershipInvite(verified, pending.membership_invite_id, exec)
            : await resolveHostedIdentity(
                verified,
                { registration_enabled: getConfig().auth.hosted.registration_enabled },
                exec,
              );
          if (resolved.kind === "registration") {
            return await issuePendingRegistration(
              {
                identity_id: resolved.identity.id,
                login_provider: adapterId,
                redirect_to: redirectTo,
                suggested_display_name: (claims as { name?: unknown } | undefined)?.name,
              },
              exec,
            );
          }
          const session = await issueBrowserSession({
            db: exec,
            tenantId: resolved.tenant.id,
            userId: resolved.membership.user_id,
            authIdentityId: resolved.identity.id,
            redirectTo: redirectTo ?? "/cockpit",
            via: "oidc_auth_code",
            metadata: { provider_id: adapterId },
          });
          session.headers.append("set-cookie", clearPendingRegistrationCookie());
          return session;
        } catch (error) {
          if (
            error instanceof SelfServiceIdentityError &&
            error.code === "tenant_unavailable" &&
            !pending.membership_invite_id
          ) {
            return new Response(null, {
              status: 302,
              headers: {
                location: `/cockpit/recovery?provider=${encodeURIComponent(adapterId)}`,
                "set-cookie": clearCookieHeader(),
                "cache-control": "no-store",
              },
            });
          }
          if (
            pending.membership_invite_id &&
            !wantsJson(req) &&
            (error instanceof MembershipInviteError || error instanceof SelfServiceIdentityError)
          ) {
            return new Response(null, {
              status: 302,
              headers: {
                location: `${INVITE_PAGE_PATH}?error=${
                  error.code === "invite_identity_mismatch"
                    ? "identity_mismatch"
                    : error.code === "invite_credential_only"
                      ? error.code
                      : "invite_unavailable"
                }`,
                "cache-control": "no-store",
              },
            });
          }
          if (
            error instanceof SelfServiceIdentityError &&
            error.code === "registration_rate_limited"
          )
            return browserError(
              req,
              429,
              error.code,
              "Registration is temporarily limited. Try again shortly.",
              "provider_unavailable",
              retryHref,
            );
          if (
            error instanceof SelfServiceIdentityError &&
            error.code === "registration_policy_unavailable"
          )
            return browserError(
              req,
              503,
              error.code,
              "Registration is temporarily unavailable.",
              "provider_unavailable",
              retryHref,
            );
          if (error instanceof ZodError) {
            return browserError(
              req,
              403,
              "invalid_identity_claims",
              "verified identity claims are invalid",
              "grant_denied",
              retryHref,
            );
          }
          if (
            error instanceof SelfServiceIdentityError ||
            error instanceof MembershipInviteError ||
            error instanceof IdentityRecoveryError
          ) {
            return browserError(
              req,
              403,
              error.code,
              "identity or workspace is not available",
              error instanceof SelfServiceIdentityError && error.code === "registration_closed"
                ? "registration_closed"
                : "account_not_assigned",
              retryHref,
            );
          }
          throw error;
        }
      }
      if (!tenantId)
        return browserError(
          req,
          400,
          "tenant_missing",
          "pending login missing tenant",
          "tenant_unavailable",
          retryHref,
        );
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
          issuerUrl,
          ...(productId ? { productId } : {}),
          email,
          linkByEmail:
            !productId && (opts.linkByEmail ?? configured?.link_by_email ?? true) && emailVerified,
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
            "account_not_assigned",
            retryHref,
          );
        }
        if (err instanceof IdentityLinkConflictError) {
          const clientRedirect = await redirectDenialToClient(exec, pending.redirect_to);
          if (clientRedirect) return clientRedirect;
          return browserError(
            req,
            403,
            "access_denied",
            "identity binding does not match the configured provider",
            "grant_denied",
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
          "grant_denied",
          retryHref,
        );
      }

      try {
        await assertTenantActive(tenantId, exec);
      } catch (error) {
        if (error instanceof SelfServiceIdentityError) {
          return browserError(
            req,
            403,
            "tenant_unavailable",
            "workspace is unavailable",
            "tenant_unavailable",
            retryHref,
          );
        }
        throw error;
      }
      const rawNonce = randomBytes(32).toString("hex");
      const tokenHash = sha256Hex(rawNonce);
      const now = new Date();
      const [sessionRow] = await exec
        .insert(sessions)
        .values({
          tenant_id: tenantId,
          user_id: userRow.id,
          product_id: productId ?? null,
          expires_at: new Date(now.getTime() + SESSION_SLIDING_TTL_MS),
          absolute_expires_at: new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS),
          last_seen_at: now,
          token_sha256: tokenHash,
        })
        .returning();
      if (!sessionRow) {
        return browserError(
          req,
          500,
          "session_insert_failed",
          "failed to create session",
          "provider_unavailable",
          retryHref,
        );
      }

      const jwt = await signSessionCookie(sessionSecret, {
        session_id: sessionRow.id,
        user_id: userRow.id,
        tenant_id: tenantId,
        login_provider: adapterId,
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

    async resolve(req: Request) {
      return await resolveOidcSession(db, sessionSecret, req);
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
      const exec = db;
      const [row] = await exec
        .update(sessions)
        .set({ revoked_at: new Date() })
        .where(eq(sessions.id, payload.session_id))
        .returning();
      if (row) {
        await endCockpitPushForSessions(
          exec,
          { tenant_id: row.tenant_id, session_ids: [row.id] },
          "session_logout",
          { actor_type: "user", actor_id: row.user_id },
        );
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
