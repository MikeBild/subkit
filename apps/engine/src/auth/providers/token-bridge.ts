// Generic JWT identity adapter for an externally hosted login bridge.

import { eq } from "drizzle-orm";
import * as jose from "jose";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { type Db, getDb } from "../../db/client.ts";
import { tenants } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { resolveProviderIdentity } from "../identity-link.ts";
import type { AuthProvider, ResolvedPrincipal } from "../types.ts";

export interface TokenBridgeProviderOptions {
  providerId: string;
  issuer: string;
  audience: string;
  jwksUrl: string;
  tenantSlug?: string;
  subjectClaim?: string;
  emailClaim?: string;
  emailVerifiedClaim?: string;
  db?: Db;
  jwks?: jose.JWTVerifyGetKey;
}

function bearer(req: Request): string | null {
  const value = req.headers.get("authorization");
  return value?.slice(0, 7).toLowerCase() === "bearer " ? value.slice(7).trim() : null;
}

function readClaim(payload: jose.JWTPayload, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[segment];
  }, payload);
}

async function tenantId(db: Db, slug: string): Promise<string | null> {
  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  return rows[0]?.id ?? null;
}

export function createTokenBridgeProvider(opts: TokenBridgeProviderOptions): AuthProvider {
  const exec = opts.db ?? getDb();
  const keys = opts.jwks ?? jose.createRemoteJWKSet(new URL(opts.jwksUrl));
  const slug = opts.tenantSlug ?? "default";

  return {
    name: opts.providerId,
    capabilities: { human: true, machine: false, interactive: true, refresh: false, revoke: false },
    async resolve(req: Request): Promise<ResolvedPrincipal | null> {
      try {
        const token = bearer(req);
        if (token?.split(".").length !== 3) return null;
        const { payload } = await jose.jwtVerify(token, keys, {
          issuer: opts.issuer,
          audience: opts.audience,
        });
        const rawSubject = readClaim(payload, opts.subjectClaim ?? "sub");
        const rawEmail = readClaim(payload, opts.emailClaim ?? "email");
        const subject = typeof rawSubject === "string" ? rawSubject : "";
        const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
        if (
          !subject ||
          !email ||
          readClaim(payload, opts.emailVerifiedClaim ?? "email_verified") !== true
        ) {
          return null;
        }
        const resolvedTenantId = await tenantId(exec, slug);
        if (!resolvedTenantId) return null;

        const { user, createdUser, linkedIdentity } = await resolveProviderIdentity(exec, {
          tenantId: resolvedTenantId,
          providerId: opts.providerId,
          subject,
          email,
          linkByEmail: true,
        });
        if (!user || user.deleted_at !== null || user.status !== "active") return null;
        if (createdUser || linkedIdentity) {
          await auditAwait(
            {
              tenant_id: resolvedTenantId,
              actor_type: "system",
              actor_id: null,
              action: createdUser ? AuditAction.USER_CREATED : AuditAction.USER_IDENTITY_LINKED,
              resource_type: "user",
              resource_id: user.id,
              result: "success",
              metadata: { source: opts.providerId, subject, email },
            },
            exec,
          );
        }
        const principal: ResolvedPrincipal = {
          provider: opts.providerId,
          kind: "user",
          id: user.id,
          tenant_id: resolvedTenantId,
          roles: [user.role],
        };
        if (user.email) principal.email = user.email;
        return principal;
      } catch (error) {
        logger.warn({
          module: "auth",
          action: "token_bridge.resolve_failed",
          msg: "token bridge assertion rejected",
          provider_id: opts.providerId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  };
}
