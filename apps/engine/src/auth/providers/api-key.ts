import { eq } from "drizzle-orm";
import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import { apiKeys } from "../../db/schema/index.ts";
import { constantTimeHexEquals, KEY_PREFIX_LITERAL, parseKey } from "../../identity/api-key.ts";
import { log } from "../../logging/index.ts";
import { recordAuthFailure } from "../failed-auth-tracker.ts";
import type { AuthProvider, ResolvedPrincipal } from "../types.ts";
import {
  type ApiKeyRow,
  resetApiKeyUsageThrottle,
  resolvePrincipalFromApiKeyRow,
} from "./api-key-row.ts";

export function extractBearerToken(req: Request): string | null {
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

export function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

export async function matchApiKeyByHash(
  db: Db,
  plaintext: string,
  req: Request | null,
  provider = "api_key",
): Promise<ApiKeyRow | null> {
  const parsed = parseKey(plaintext);
  if (!parsed) {
    if (plaintext.startsWith(KEY_PREFIX_LITERAL)) {
      log.auth.denied({ provider, reason: "malformed_token" });
    }
    return null;
  }

  // tenant-filter:exempt — prefix-based credential lookup pre-tenant
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.prefix, parsed.prefix)).limit(1);
  const row = rows[0];

  if (!row) {
    log.auth.denied({ provider, reason: "prefix_not_found", prefix: parsed.prefix });
    return null;
  }

  if (!constantTimeHexEquals(row.token_sha256, parsed.hash)) {
    if (req) recordAuthFailure(clientIp(req));
    log.auth.denied({
      provider,
      reason: "hash_mismatch",
      prefix: parsed.prefix,
      api_key_id: row.id,
    });
    audit(
      {
        tenant_id: row.tenant_id,
        actor_type: "system",
        action: AuditAction.API_KEY_USED,
        resource_type: "api_key",
        resource_id: row.id,
        result: "denied",
        reason: "hash_mismatch",
        metadata: { prefix: parsed.prefix },
      },
      db,
    );
    return null;
  }
  return row;
}

export interface ApiKeyProviderOptions {
  db: Db;
  resetThrottle?: boolean;
}

export function createApiKeyProvider(opts: ApiKeyProviderOptions): AuthProvider {
  if (opts.resetThrottle) resetApiKeyUsageThrottle();
  return {
    name: "api_key",
    capabilities: {
      human: true,
      machine: true,
      interactive: false,
      refresh: false,
      revoke: true,
    },
    async resolve(req: Request): Promise<ResolvedPrincipal | null> {
      const token = extractBearerToken(req);
      if (!token) return null;
      const db = opts.db;
      const row = await matchApiKeyByHash(db, token, req);
      if (!row) return null;
      return resolvePrincipalFromApiKeyRow(db, row, { provider: "api_key" });
    },
  };
}
