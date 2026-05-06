// portal_token auth provider — real implementation.
//
// - Parses `Authorization: Bearer wf_portal_<rand>` or `?token=<key>` query
// - Looks up `portal_tokens` row by prefix
// - Constant-time sha256 comparison
// - Validates expires_at / revoked_at
// - Returns a ResolvedPrincipal scoped to the enduser with the token's
//   `allowed_workflows` column carried through so the policy layer can
//   gate workflow runs.
//
// Portal tokens are prefix-distinct from api keys (`wf_portal_` vs
// `wf_live_`), so the registry can walk providers in any order — each
// one rejects foreign prefixes fast. We still register the portal-token
// provider first so it short-circuits the api-key lookup entirely.

import { eq } from "drizzle-orm";
import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { type Db, getDb } from "../../db/client.ts";
import { portalTokens, users } from "../../db/schema/index.ts";
import { constantTimeHexEquals } from "../../identity/api-key.ts";
import { parsePortalToken } from "../../identity/portal-token.ts";
import { log } from "../../logging/logger.ts";
import type { AllowList, AuthProvider, ResolvedPrincipal } from "../types.ts";

function extractToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.length > 7 && auth.slice(0, 7).toLowerCase() === "bearer ") {
    return auth.slice(7).trim();
  }
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("token");
    if (q) return q;
  } catch {
    // non-absolute URL — nothing to pull
  }
  return null;
}

function normalizeAllowList(value: unknown): AllowList {
  if (Array.isArray(value)) {
    if (value.length === 1 && value[0] === "*") return "all";
    return value as string[];
  }
  // A portal token with no allowlist is meaningless — treat as empty.
  return [];
}

export interface PortalTokenProviderOptions {
  db?: Db;
}

export function createPortalTokenProvider(opts: PortalTokenProviderOptions = {}): AuthProvider {
  return {
    name: "portal_token",
    capabilities: {
      human: true,
      machine: false,
      interactive: false,
      refresh: false,
      revoke: true,
    },
    async resolve(req: Request): Promise<ResolvedPrincipal | null> {
      const token = extractToken(req);
      if (!token) return null;

      const parsed = parsePortalToken(token);
      if (!parsed) {
        // Not a portal token — let the next provider in the registry try.
        return null;
      }

      const db = opts.db ?? getDb();
      // tenant-filter:exempt — portal-token JTI lookup pre-tenant
      const rows = await db
        .select()
        .from(portalTokens)
        .where(eq(portalTokens.prefix, parsed.prefix))
        .limit(1);
      const row = rows[0];

      if (!row) {
        log.auth.denied({
          provider: "portal_token",
          reason: "prefix_not_found",
          prefix: parsed.prefix,
        });
        return null;
      }

      if (!constantTimeHexEquals(row.token_sha256, parsed.hash)) {
        log.auth.denied({
          provider: "portal_token",
          reason: "hash_mismatch",
          prefix: parsed.prefix,
          portal_token_id: row.id,
        });
        audit(
          {
            tenant_id: row.tenant_id,
            actor_type: "system",
            action: AuditAction.POLICY_DENIED,
            resource_type: "portal_token",
            resource_id: row.id,
            result: "denied",
            reason: "hash_mismatch",
            metadata: { prefix: parsed.prefix },
          },
          db,
        );
        return null;
      }

      const now = new Date();
      if (row.revoked_at && row.revoked_at <= now) {
        log.auth.denied({
          provider: "portal_token",
          reason: "revoked",
          portal_token_id: row.id,
        });
        return null;
      }
      if (row.expires_at && row.expires_at <= now) {
        log.auth.denied({
          provider: "portal_token",
          reason: "expired",
          portal_token_id: row.id,
        });
        return null;
      }

      // Portal tokens are always enduser-owned. `enduser_ref` may be a
      // user_id (most common) or an opaque external reference — we only
      // try to resolve the email if the ref matches a real users row.
      const ownerId = row.enduser_ref;
      let email: string | undefined;
      try {
        // tenant-filter:exempt — portal-token JTI lookup pre-tenant
        const u = await db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, ownerId))
          .limit(1);
        if (u[0]?.email) email = u[0].email;
      } catch {
        // Non-UUID enduser_ref will throw — safe to ignore. The
        // principal still resolves; it just has no email hint.
      }

      const principal: ResolvedPrincipal = {
        provider: "portal_token",
        kind: "user",
        id: ownerId,
        tenant_id: row.tenant_id,
        roles: ["enduser"],
        scopes: ["portal"],
        allowed_workflows: normalizeAllowList(row.allowed_workflows),
      };
      if (email !== undefined) principal.email = email;

      log.auth.resolved({
        provider: "portal_token",
        principal_kind: "user",
        principal_id: ownerId,
        portal_token_id: row.id,
        tenant_id: row.tenant_id,
      });

      return principal;
    },
  };
}
