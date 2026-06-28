// POST /v1/identity/sessions/oidc — exchange an OIDC id_token for a
// personal subkit API key. Used by `sk login` after a successful
// device-code flow.
//
// Flow:
//   1. Body carries {id_token, issuer}.
//   2. We discover the issuer's JWKS via openid-client (so the same
//      cache/insecure-http handling as the rest of the engine) and
//      validate the id_token signature + iss claim with jose.
//   3. Look up the User row in the v1 hardcoded `default` tenant by
//      oidc_subject; create one if missing (email := claim or sub@<host>).
//   4. Issue a personal API key bound to that user via the existing
//      identity.issueApiKey path. The plaintext is returned once.
//   5. Audit `session.issued` + `user.logged_in` for traceability.
//
// The route is intentionally public (no requireAuth) — the caller has
// no API key yet at this point. Authn is the id_token signature itself.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import * as jose from "jose";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import { getConfig } from "../../../config/loader.ts";
import { tenants, users } from "../../../db/schema/index.ts";
import * as identity from "../../../identity/index.ts";
import { type DiscoveryDoc, fetchDiscovery } from "../../../identity/index.ts";
import { logger } from "../../../logging/index.ts";
import { BadRequestError, ForbiddenError, UnauthorizedError } from "../../errors.ts";
import type { AppEnv } from "../../openapi.ts";
import { ErrorSchema } from "./schemas.ts";

const SessionsOidcBody = z
  .object({
    id_token: z.string().min(1),
    issuer: z.string().url(),
  })
  .openapi("SessionsOidcBody");

const SessionsOidcResponse = z
  .object({
    api_key: z.string(),
    user_id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    sub: z.string(),
  })
  .openapi("SessionsOidcResponse");

const route = createRoute({
  method: "post",
  path: "/v1/identity/sessions/oidc",
  tags: ["identity"],
  summary: "Exchange an OIDC id_token for a personal subkit API key",
  request: {
    body: { content: { "application/json": { schema: SessionsOidcBody } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: SessionsOidcResponse } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Invalid id_token",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "OIDC login not configured, or issuer not allow-listed",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const DEFAULT_TENANT_SLUG = "default";

// Normalize an issuer URL for comparison: drop a single trailing slash so
// "https://idp/" and "https://idp" compare equal. Throws on invalid URLs.
function normalizeIssuer(value: string): string {
  return new URL(value).toString().replace(/\/$/, "");
}

export function registerSessionsOidcRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const db = c.get("db");
    const body = c.req.valid("json");

    // Allow-list gate: the route mints a personal API key, so the issuer
    // MUST be the operator-configured OIDC provider. Without this, an
    // attacker runs their own issuer + JWKS, self-signs an id_token, and
    // the public route hands back a key. An unconfigured issuer also
    // closes the discovery SSRF vector (the URL is no longer attacker-
    // chosen). Audience is pinned to the configured client_id below.
    const oidcCfg = getConfig().auth.oidc;
    const configuredIssuer = oidcCfg.issuer_url?.trim() ?? "";
    if (!configuredIssuer) {
      throw new ForbiddenError("oidc login is not configured");
    }

    let issuerUrl: URL;
    try {
      issuerUrl = new URL(body.issuer);
    } catch {
      throw new BadRequestError("issuer must be a valid URL");
    }
    try {
      if (normalizeIssuer(body.issuer) !== normalizeIssuer(configuredIssuer)) {
        throw new ForbiddenError("issuer not allow-listed");
      }
    } catch (err) {
      if (err instanceof ForbiddenError) throw err;
      throw new BadRequestError("issuer must be a valid URL");
    }
    // Discover from the configured issuer (not the request body) so the
    // verified key set is always the operator's, regardless of body input.
    const discoverUrl = new URL(configuredIssuer);

    let disco: DiscoveryDoc;
    try {
      disco = await fetchDiscovery(discoverUrl);
    } catch (err) {
      logger.warn({
        module: "auth",
        action: "oidc.discovery_failed",
        msg: "discovery failed",
        issuer: body.issuer,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new BadRequestError("discovery failed");
    }
    if (!disco.jwks_uri) {
      throw new BadRequestError("issuer metadata missing jwks_uri");
    }

    let claims: jose.JWTPayload;
    try {
      const jwks = jose.createRemoteJWKSet(new URL(disco.jwks_uri));
      const expectedAudience = oidcCfg.client_id?.trim() ?? "";
      const result = await jose.jwtVerify(body.id_token, jwks, {
        issuer: disco.issuer,
        // Pin audience to the configured client_id so a token minted for a
        // different relying party at the same IdP cannot be replayed here.
        ...(expectedAudience ? { audience: expectedAudience } : {}),
      });
      claims = result.payload;
    } catch (err) {
      logger.warn({
        module: "auth",
        action: "oidc.verify_failed",
        msg: "id_token verification failed",
        error: err instanceof Error ? err.message : String(err),
      });
      throw new UnauthorizedError("id_token verification failed");
    }

    const sub = typeof claims.sub === "string" ? claims.sub : null;
    if (!sub) throw new UnauthorizedError("id_token missing sub");
    // Only trust the `email` claim when the IdP asserts it is verified;
    // otherwise fall back to a synthetic, collision-free address keyed on
    // sub so an unverified claim can neither be trusted nor collide with a
    // real account's email.
    const emailVerified = claims.email_verified === true;
    const email =
      emailVerified && typeof claims.email === "string" && claims.email.length > 0
        ? claims.email
        : `${sub}@${issuerUrl.host}`;

    // v1: hardcoded default tenant. Real multi-tenant resolution by
    // domain / email-mapping is later phase work.
    const [tenantRow] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, DEFAULT_TENANT_SLUG))
      .limit(1);
    if (!tenantRow) {
      throw new BadRequestError("default tenant not provisioned");
    }
    const tenant_id = tenantRow.id;

    // Find or create the user row keyed on oidc_subject.
    const existingByOidc = await db
      .select()
      .from(users)
      .where(and(eq(users.tenant_id, tenant_id), eq(users.oidc_subject, sub)))
      .limit(1);
    let userRow = existingByOidc[0];

    if (!userRow) {
      // Try to attach to an existing email row to avoid duplicate accounts
      // when the same human signed in via email earlier. This is the
      // account-takeover hot spot: linking by email lets a token whose
      // `email` claim names another user (e.g. an admin) rebind that
      // account to the attacker's `sub`. Two guards close it:
      //   1. The IdP must assert `email_verified === true`.
      //   2. We only link a row that has no OIDC binding yet — never
      //      overwrite an existing `oidc_subject`.
      const existingByEmail = emailVerified
        ? await db
            .select()
            .from(users)
            .where(and(eq(users.tenant_id, tenant_id), eq(users.email, email)))
            .limit(1)
        : [];
      if (existingByEmail[0] && existingByEmail[0].oidc_subject) {
        // The email maps to an account already bound to a different OIDC
        // subject — refuse rather than hijack it.
        throw new ForbiddenError("account already linked to a different identity");
      }
      if (existingByEmail[0]) {
        const [updated] = await db
          .update(users)
          .set({ oidc_subject: sub })
          .where(eq(users.id, existingByEmail[0].id))
          .returning();
        userRow = updated;
      } else {
        const [created] = await db
          .insert(users)
          .values({
            tenant_id,
            email,
            role: "member",
            oidc_subject: sub,
          })
          .returning();
        userRow = created;
        if (userRow) {
          await auditAwait(
            {
              tenant_id,
              actor_type: "system",
              actor_id: null,
              action: AuditAction.USER_CREATED,
              resource_type: "user",
              resource_id: userRow.id,
              result: "success",
              metadata: { sub, email, source: "oidc_session" },
            },
            db,
          );
        }
      }
    }

    if (!userRow) throw new Error("failed to resolve user row");

    // Issue a personal key. We use the existing identity service so the
    // hash + audit chain stays consistent with /v1/identity/api-keys.
    const issued = await identity.issueApiKey(
      {
        tenant_id,
        owner_kind: "user",
        owner_id: userRow.id,
        scopes: ["*"],
        actor_id: userRow.id,
      },
      db,
    );

    await auditAwait(
      {
        tenant_id,
        actor_type: "user",
        actor_id: userRow.id,
        action: AuditAction.SESSION_ISSUED,
        resource_type: "session",
        resource_id: issued.view.id,
        result: "success",
        metadata: { sub, issuer: disco.issuer, via: "oidc_device_flow" },
      },
      db,
    );
    await auditAwait(
      {
        tenant_id,
        actor_type: "user",
        actor_id: userRow.id,
        action: AuditAction.USER_LOGGED_IN,
        resource_type: "user",
        resource_id: userRow.id,
        result: "success",
        metadata: { sub, issuer: disco.issuer },
      },
      db,
    );

    // Tag sk-cli-originated logins with a dedicated audit action so
    // operators can filter the SOC2 evidence stream by tool.
    const userAgent = c.req.header("user-agent") ?? "";
    if (userAgent.startsWith("sk-cli/")) {
      await auditAwait(
        {
          tenant_id,
          actor_type: "user",
          actor_id: userRow.id,
          action: AuditAction.SK_CLI_LOGIN,
          resource_type: "user",
          resource_id: userRow.id,
          result: "success",
          metadata: { sub, issuer: disco.issuer, user_agent: userAgent },
        },
        db,
      );
    }

    return c.json(
      {
        api_key: issued.plaintext,
        user_id: userRow.id,
        tenant_id,
        sub,
      },
      200,
    );
  });
}
