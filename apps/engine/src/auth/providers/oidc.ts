// oidc auth provider — real implementation (Pass 2 A1).
//
// Full authorization-code + PKCE + session-cookie flow, built on
// `openid-client` v6 (function-shape). A companion file in
// `http/routes/identity/login.ts` wires the three HTTP entrypoints to
// the provider methods declared here:
//
//   GET  /v1/identity/login/start     → startLogin
//   GET  /v1/identity/login/callback  → finishLogin
//   POST /v1/identity/logout          → revoke
//
// `resolve()` is the middleware-side surface. It reads the signed
// `subkit_session` cookie, verifies the JWS, loads the `sessions` row,
// enforces sliding (8 h) + absolute (30 d) TTLs, and returns a
// populated ResolvedPrincipal.
//
// All HTTP cookies carry a JWS signed by the env-derived session
// secret, never the plaintext session id. The session id is extracted
// from the payload after verification. This matches the production
// guidance from docs/11-identity.md.
//
// The migration `0016_p2_oidc_state.sql` adds:
//   - `oidc_login_states`
//   - `users.external_subject`
//   - `sessions.token_sha256`

import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import * as jose from "jose";
import * as oauth from "openid-client";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { type Db, getDb } from "../../db/client.ts";
import { oidcLoginStates, sessions, tenants, users } from "../../db/schema/index.ts";
import { env } from "../../env.ts";
import { logger } from "../../logging/logger.ts";
import type { AuthProvider, ResolvedPrincipal } from "../types.ts";

const SESSION_COOKIE = "subkit_session";
const DEFAULT_TENANT_SLUG = "default";
const LOGIN_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_SLIDING_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const JWS_ALG = "HS256";

export interface OidcProviderOptions {
  issuerUrl?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  db?: Db;
  sessionSecret?: Uint8Array;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deriveSessionSecret(override?: Uint8Array): Uint8Array {
  if (override) return override;
  const fromEnv = (process.env.SESSION_SECRET ?? "").trim();
  if (fromEnv.length > 0) {
    return new TextEncoder().encode(fromEnv);
  }
  // Deterministic fallback so tests + local dev work without a
  // dedicated SESSION_SECRET env var. Derivation binds the session
  // key to the master encryption key so rolling MASTER_KEY also
  // rolls session signatures.
  return new Uint8Array(createHash("sha256").update(`${env.MASTER_KEY}:session`).digest());
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
  const issuerUrl = opts.issuerUrl ?? process.env.OIDC_ISSUER_URL ?? "";
  const clientId = opts.clientId ?? process.env.OIDC_CLIENT_ID ?? "";
  const clientSecretInput = opts.clientSecret ?? process.env.OIDC_CLIENT_SECRET;
  const redirectUri = opts.redirectUri ?? process.env.OIDC_REDIRECT_URI ?? "";
  const sessionSecret = deriveSessionSecret(opts.sessionSecret);
  const db = opts.db;

  function getExec(): Db {
    return db ?? getDb();
  }

  return {
    name: "oidc",
    capabilities: {
      human: true,
      machine: false,
      interactive: true,
      refresh: true,
      revoke: true,
    },

    async startLogin(req: Request): Promise<Response> {
      if (!issuerUrl || !clientId || !redirectUri) {
        return httpError(500, "oidc_not_configured", "oidc provider not configured");
      }
      const url = new URL(req.url);
      const tenantSlug = url.searchParams.get("tenant");
      const redirectTo = url.searchParams.get("redirect_to");
      const exec = getExec();

      const tenantId = await resolveTenantId(exec, tenantSlug);
      if (!tenantId) {
        return httpError(400, "unknown_tenant", "tenant not found");
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
        return httpError(502, "oidc_discovery_failed", "issuer discovery failed");
      }

      const code_verifier = oauth.randomPKCECodeVerifier();
      const code_challenge = await oauth.calculatePKCECodeChallenge(code_verifier);
      const state = oauth.randomState();
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
        scope: "openid profile email",
        state,
        nonce,
        code_challenge,
        code_challenge_method: "S256",
      });

      return Response.redirect(authUrl.toString(), 302);
    },

    async finishLogin(req: Request): Promise<Response> {
      if (!issuerUrl || !clientId || !redirectUri) {
        return httpError(500, "oidc_not_configured", "oidc provider not configured");
      }
      const reqUrl = new URL(req.url);
      const state = reqUrl.searchParams.get("state");
      if (!state) {
        return httpError(400, "missing_state", "state parameter missing");
      }
      const exec = getExec();

      // Best-effort GC of expired pending rows. Does not block.
      void exec
        .delete(oidcLoginStates)
        .where(lt(oidcLoginStates.expires_at, new Date()))
        .catch(() => {});

      // Atomic load + delete so replays of the same state can't finish
      // twice. We use a transaction to bracket the read and the delete.
      const pending = await exec.transaction(async (tx) => {
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
        return httpError(400, "unknown_state", "state not recognised");
      }
      if (pending.expires_at.getTime() < Date.now()) {
        return httpError(400, "expired_state", "login state expired");
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
        return httpError(502, "oidc_discovery_failed", "issuer discovery failed");
      }

      let tokens: oauth.TokenEndpointResponse & oauth.TokenEndpointResponseHelpers;
      try {
        tokens = await oauth.authorizationCodeGrant(configuration, new URL(req.url), {
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
        return httpError(401, "oidc_code_exchange_failed", "token exchange failed");
      }

      const claims = tokens.claims();
      const sub = typeof claims?.sub === "string" ? claims.sub : null;
      if (!sub) {
        return httpError(401, "oidc_missing_sub", "id_token missing sub");
      }
      const rawEmail = (claims as { email?: unknown } | undefined)?.email;
      const email =
        typeof rawEmail === "string" && rawEmail.length > 0
          ? rawEmail
          : `${sub}@${new URL(issuerUrl).host}`;

      // Upsert the user row keyed on (tenant_id, external_subject).
      const existing = await exec
        .select()
        .from(users)
        .where(and(eq(users.tenant_id, tenantId), eq(users.external_subject, sub)))
        .limit(1);
      let userRow = existing[0];
      let createdUser = false;
      if (!userRow) {
        // Try to reuse an email-match row before creating a new user.
        const byEmail = await exec
          .select()
          .from(users)
          .where(and(eq(users.tenant_id, tenantId), eq(users.email, email)))
          .limit(1);
        if (byEmail[0]) {
          const [updated] = await exec
            .update(users)
            .set({ external_subject: sub })
            .where(eq(users.id, byEmail[0].id))
            .returning();
          userRow = updated;
        } else {
          const [created] = await exec
            .insert(users)
            .values({
              tenant_id: tenantId,
              email,
              role: "member",
              external_subject: sub,
            })
            .returning();
          userRow = created;
          createdUser = true;
        }
      }
      if (!userRow) {
        return httpError(500, "user_upsert_failed", "failed to resolve user row");
      }

      // Mint + persist a new session.
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

      const target = pending.redirect_to ?? "/";
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

      // Fire-and-forget sliding window bump. We do not block the
      // resolve on the write finishing.
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

      const userRows = await exec
        .select({ role: users.role, email: users.email })
        .from(users)
        .where(eq(users.id, row.user_id))
        .limit(1);
      const u = userRows[0];
      if (!u) return null;

      const principal: ResolvedPrincipal = {
        provider: "oidc",
        kind: "user",
        id: row.user_id,
        tenant_id: row.tenant_id,
        roles: [u.role],
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
