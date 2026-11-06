import { and, eq } from "drizzle-orm";
import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
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
  } catch {}
  return null;
}

function normalizeAllowList(value: unknown): AllowList {
  if (Array.isArray(value)) {
    if (value.length === 1 && value[0] === "*") return "all";
    return value as string[];
  }
  return [];
}

export interface PortalTokenProviderOptions {
  db: Db;
}

export function createPortalTokenProvider(opts: PortalTokenProviderOptions): AuthProvider {
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
        return null;
      }

      const db = opts.db;
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

      const ownerId = row.enduser_ref;
      let email: string | undefined;
      try {
        const u = await db
          .select({ email: users.email })
          .from(users)
          .where(and(eq(users.id, ownerId), eq(users.tenant_id, row.tenant_id)))
          .limit(1);
        if (u[0]?.email) email = u[0].email;
      } catch {}

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
