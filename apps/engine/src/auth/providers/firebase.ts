// firebase auth provider — stateless Firebase ID-token (JWT) verifier.
//
// Firebase issues short-lived ID tokens (JWTs) signed by Google's Secure
// Token service. A web client (the hosted login page) signs the user in
// with Google and forwards the resulting ID token as a bearer credential:
//
//   Authorization: Bearer <firebase_id_token>
//
// This provider is the middleware-side surface only — there is no
// server-side login funnel, no cookie, no session row. Each request is
// authenticated by verifying the token signature against Firebase's
// rotating JWKS:
//
//   - issuer  : https://securetoken.google.com/<projectId>
//   - audience: <projectId>
//   - JWKS    : discovered from
//               https://securetoken.google.com/<projectId>/.well-known/openid-configuration
//
// On the first successful verification for a (tenant, sub) pair a `users`
// row is upserted (keyed on external_subject, matching the OIDC provider)
// and `user.created` is audited. The user maps into the tenant named by
// `auth.firebase.tenant_slug` (default "default").
//
// resolve() never throws: a malformed or unverifiable token resolves to
// null so the registry can try the next provider, and a bad token can
// never lock the door.

import { and, eq } from "drizzle-orm";
import * as jose from "jose";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { getConfig } from "../../config/loader.ts";
import { type Db, getDb } from "../../db/client.ts";
import { tenants, users } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import type { AuthProvider, ResolvedPrincipal } from "../types.ts";

const DEFAULT_TENANT_SLUG = "default";

export interface FirebaseProviderOptions {
  projectId?: string;
  tenantSlug?: string;
  db?: Db;
  /** Test seam: inject a key resolver to skip remote JWKS discovery. When
   *  set, `getJwks()` returns this directly and no network fetch occurs, so
   *  unit tests verify real signatures against a local key without stubbing
   *  globalThis.fetch. */
  jwks?: jose.JWTVerifyGetKey;
}

function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.length > 7 && auth.slice(0, 7).toLowerCase() === "bearer ") {
    return auth.slice(7).trim();
  }
  return null;
}

/**
 * isJwt — a Firebase ID token is a JWS compact serialization: three
 * base64url segments joined by two dots. subkit's own opaque keys
 * (`wf_live_*`, `wf_portal_*`, `wf_mcp_*`) never contain two dots, so this
 * predicate lets us decline non-JWT bearers without ever touching the DB
 * or the network.
 */
function isJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

async function resolveTenantId(db: Db, slug: string): Promise<string | null> {
  // tenant-filter:exempt — slug → tenant_id lookup is the tenant resolver itself
  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  return rows[0]?.id ?? null;
}

export function createFirebaseProvider(opts: FirebaseProviderOptions = {}): AuthProvider {
  let firebaseCfg: { project_id: string; tenant_slug: string } = {
    project_id: "",
    tenant_slug: DEFAULT_TENANT_SLUG,
  };
  try {
    const cfg = getConfig().auth.firebase;
    firebaseCfg = { project_id: cfg.project_id, tenant_slug: cfg.tenant_slug };
  } catch {
    /* loader not initialised — unit tests pass values via opts */
  }

  const projectId = (opts.projectId ?? firebaseCfg.project_id ?? "").trim();
  const tenantSlug = opts.tenantSlug ?? firebaseCfg.tenant_slug ?? DEFAULT_TENANT_SLUG;
  const db = opts.db;

  const issuer = `https://securetoken.google.com/${projectId}`;
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;

  // The JWKS set is discovered lazily on the first verify and memoised for
  // the lifetime of this provider instance. `createRemoteJWKSet` itself
  // caches the fetched keys and re-fetches on a `kid` miss, so we build it
  // exactly once per instance.
  let jwksSet: jose.JWTVerifyGetKey | null = opts.jwks ?? null;
  async function getJwks(): Promise<jose.JWTVerifyGetKey | null> {
    if (jwksSet) return jwksSet;
    const res = await fetch(discoveryUrl);
    if (!res.ok) {
      logger.warn({
        module: "auth",
        action: "firebase.discovery_failed",
        msg: "firebase issuer discovery failed",
        status: res.status,
      });
      return null;
    }
    const disco = (await res.json()) as { jwks_uri?: unknown };
    if (typeof disco.jwks_uri !== "string" || !disco.jwks_uri) {
      logger.warn({
        module: "auth",
        action: "firebase.discovery_failed",
        msg: "firebase issuer metadata missing jwks_uri",
      });
      return null;
    }
    jwksSet = jose.createRemoteJWKSet(new URL(disco.jwks_uri));
    return jwksSet;
  }

  function getExec(): Db {
    return db ?? getDb();
  }

  return {
    name: "firebase",
    capabilities: {
      human: true,
      machine: false,
      interactive: true,
      refresh: false,
      revoke: false,
    },

    async resolve(req: Request): Promise<ResolvedPrincipal | null> {
      try {
        if (!projectId) return null;

        const token = extractBearer(req);
        if (!token) return null;
        // Decline non-JWT bearers (e.g. wf_* opaque keys) without any
        // network or DB access — those belong to other providers.
        if (!isJwt(token)) return null;

        const jwks = await getJwks();
        if (!jwks) return null;

        let claims: jose.JWTPayload;
        try {
          const result = await jose.jwtVerify(token, jwks, {
            issuer,
            audience: projectId,
          });
          claims = result.payload;
        } catch {
          // Signature / issuer / audience / expiry mismatch — let other
          // providers try. Do not surface as an auth grant.
          return null;
        }

        const sub = typeof claims.sub === "string" ? claims.sub : null;
        if (!sub) return null;
        const rawEmail = (claims as { email?: unknown }).email;
        const email =
          typeof rawEmail === "string" && rawEmail.length > 0
            ? rawEmail
            : `${sub}@${projectId}.firebaseapp.com`;

        const exec = getExec();
        const tenantId = await resolveTenantId(exec, tenantSlug);
        if (!tenantId) {
          logger.warn({
            module: "auth",
            action: "firebase.tenant_missing",
            msg: "firebase tenant slug not provisioned",
            tenant_slug: tenantSlug,
          });
          return null;
        }

        // Upsert the user row keyed on (tenant_id, external_subject),
        // mirroring the OIDC provider so the same human maps to one row
        // regardless of which provider authenticated them.
        // tenant-filter:exempt — external_subject lookup is tenant-scoped above
        const existing = await exec
          .select()
          .from(users)
          .where(and(eq(users.tenant_id, tenantId), eq(users.external_subject, sub)))
          .limit(1);
        let userRow = existing[0];
        let createdUser = false;
        let linkedUser = false;
        if (!userRow) {
          // tenant-filter:exempt — email-match fallback is tenant-scoped above
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
            linkedUser = true;
          } else {
            // onConflictDoNothing on (tenant_id, external_subject): if a
            // concurrent first-hit for the same subject already inserted the
            // row, this insert returns nothing and we re-select the winner.
            const [created] = await exec
              .insert(users)
              .values({
                tenant_id: tenantId,
                email,
                role: "member",
                external_subject: sub,
              })
              .onConflictDoNothing({ target: [users.tenant_id, users.external_subject] })
              .returning();
            if (created) {
              userRow = created;
              createdUser = true;
            } else {
              // tenant-filter:exempt — external_subject re-select is tenant-scoped
              const winner = await exec
                .select()
                .from(users)
                .where(and(eq(users.tenant_id, tenantId), eq(users.external_subject, sub)))
                .limit(1);
              userRow = winner[0];
            }
          }
        }
        if (!userRow) return null;

        // A disabled or soft-deleted account must not authenticate, even
        // with a valid Firebase ID token. Freshly created users default to
        // status "active", so this only rejects pre-existing deactivated
        // rows.
        if (userRow.deleted_at !== null || userRow.status !== "active") {
          logger.warn({
            module: "auth",
            action: "firebase.user_inactive",
            msg: "rejected firebase login for inactive user",
            reason: userRow.deleted_at !== null ? "user_deleted" : "user_disabled",
          });
          return null;
        }

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
              metadata: { sub, email, source: "firebase" },
            },
            exec,
          );
        } else if (linkedUser) {
          await auditAwait(
            {
              tenant_id: tenantId,
              actor_type: "system",
              actor_id: null,
              action: AuditAction.USER_IDENTITY_LINKED,
              resource_type: "user",
              resource_id: userRow.id,
              result: "success",
              metadata: { source: "firebase", external_subject: sub, email },
            },
            exec,
          );
        }

        const principal: ResolvedPrincipal = {
          provider: "firebase",
          kind: "user",
          id: userRow.id,
          tenant_id: tenantId,
          roles: [userRow.role],
        };
        if (userRow.email) principal.email = userRow.email;
        return principal;
      } catch (err) {
        logger.warn({
          module: "auth",
          action: "firebase.resolve_failed",
          msg: "firebase resolve threw — declining",
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
  };
}
