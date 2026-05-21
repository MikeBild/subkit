// MCP OAuth auth provider — validates Bearer wf_mcp_* tokens.
//
// - Parses `Authorization: Bearer wf_mcp_<rand>` headers
// - Rejects non-wf_mcp_ prefixes fast (return null — other providers handle them)
// - Looks up mcp_oauth_access_tokens row by prefix
// - Constant-time sha256 comparison
// - Validates revoked_at / expires_at
// - Throttled last_used_at flush (once per 60s per token)
// - Sampled audit on flush window
// - Builds a ResolvedPrincipal with tenant + roles + scopes from the token

import { and, eq } from "drizzle-orm";
import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { type Db, getDb } from "../../db/client.ts";
import { mcpOauthAccessTokens, roles as rolesTable, users } from "../../db/schema/index.ts";
import { sha256Hex } from "../../identity/api-key.ts";
import { log, logger } from "../../logging/logger.ts";
import { recordAuthFailure } from "../failed-auth-tracker.ts";
import {
  ACCESS_TOKEN_PREFIX_LITERAL,
  constantTimeHexEquals,
  TOKEN_PREFIX_LENGTH,
} from "../oauth/tokens.ts";
import type { AuthProvider, ResolvedPrincipal } from "../types.ts";

const FLUSH_INTERVAL_MS = 60_000;
const lastFlush = new Map<string, number>();

function extractMcpToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  if (auth.length <= 7) return null;
  if (auth.slice(0, 7).toLowerCase() !== "bearer ") return null;
  const token = auth.slice(7).trim();
  // Fast prefix reject — let other providers handle their own prefixes
  if (!token.startsWith(ACCESS_TOKEN_PREFIX_LITERAL)) return null;
  return token;
}

async function maybeFlushLastUsed(
  db: Db,
  tokenId: string,
  tenantId: string,
  prefix: string,
): Promise<void> {
  const now = Date.now();
  const last = lastFlush.get(tokenId) ?? 0;
  if (now - last < FLUSH_INTERVAL_MS) return;
  lastFlush.set(tokenId, now);

  // Awaited (not fire-and-forget): the throttle caps this to once per
  // 60s per token, so blocking resolve() on one indexed UPDATE costs
  // effectively nothing and keeps the flush deterministically testable.
  await db
    .update(mcpOauthAccessTokens)
    .set({ last_used_at: new Date(now) })
    .where(and(eq(mcpOauthAccessTokens.id, tokenId), eq(mcpOauthAccessTokens.tenant_id, tenantId)))
    .catch((err: unknown) => {
      logger.warn({
        module: "auth",
        action: "mcp_oauth.last_used_flush_failed",
        msg: "failed to update mcp_oauth_access_tokens.last_used_at",
        token_id: tokenId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  audit(
    {
      tenant_id: tenantId,
      actor_type: "system",
      action: AuditAction.MCP_OAUTH_TOKEN_USED,
      resource_type: "mcp_oauth_token",
      resource_id: tokenId,
      result: "success",
      // The flush fires from the /mcp resource-server request path.
      metadata: {
        request_source: "mcp",
        prefix,
        sampled: true,
        window_ms: FLUSH_INTERVAL_MS,
      },
    },
    db,
  );
}

export interface McpOAuthProviderOptions {
  db?: Db;
  resetThrottle?: boolean;
}

export function createMcpOAuthAuthProvider(opts: McpOAuthProviderOptions = {}): AuthProvider {
  if (opts.resetThrottle) lastFlush.clear();
  return {
    name: "mcp_oauth",
    capabilities: {
      human: true,
      machine: false,
      interactive: false,
      refresh: true,
      revoke: true,
    },
    async resolve(req: Request): Promise<ResolvedPrincipal | null> {
      const token = extractMcpToken(req);
      if (!token) return null;

      if (token.length < TOKEN_PREFIX_LENGTH + 8) {
        log.auth.denied({ provider: "mcp_oauth", reason: "malformed_token" });
        return null;
      }

      const prefix = token.slice(0, TOKEN_PREFIX_LENGTH);
      const tokenHash = sha256Hex(token);

      const db = opts.db ?? getDb();
      // tenant-filter:exempt — prefix-based credential lookup pre-tenant
      const rows = await db
        .select()
        .from(mcpOauthAccessTokens)
        .where(eq(mcpOauthAccessTokens.prefix, prefix))
        .limit(1);
      const row = rows[0];

      if (!row) {
        log.auth.denied({
          provider: "mcp_oauth",
          reason: "prefix_not_found",
          prefix,
        });
        return null;
      }

      if (!constantTimeHexEquals(row.token_sha256, tokenHash)) {
        const ip =
          req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          req.headers.get("x-real-ip") ??
          "unknown";
        recordAuthFailure(ip);
        log.auth.denied({
          provider: "mcp_oauth",
          reason: "hash_mismatch",
          prefix,
          token_id: row.id,
        });
        return null;
      }

      const now = new Date();

      if (row.revoked_at && row.revoked_at <= now) {
        log.auth.denied({ provider: "mcp_oauth", reason: "revoked", token_id: row.id });
        return null;
      }

      if (row.expires_at <= now) {
        log.auth.denied({ provider: "mcp_oauth", reason: "expired", token_id: row.id });
        return null;
      }

      // Resolve user roles. The token row's tenant_id is the trusted
      // binding — require the user record to still belong to that tenant
      // (defence in depth: denies a token whose user was moved or
      // recreated under a different tenant since the token was issued).
      const userRows = await db
        .select({
          role: users.role,
          email: users.email,
          role_id: users.role_id,
          role_name: rolesTable.name,
        })
        .from(users)
        .leftJoin(rolesTable, eq(rolesTable.id, users.role_id))
        .where(and(eq(users.id, row.user_id), eq(users.tenant_id, row.tenant_id)))
        .limit(1);
      const u = userRows[0];
      if (!u) {
        log.auth.denied({
          provider: "mcp_oauth",
          reason: "user_missing",
          token_id: row.id,
        });
        return null;
      }

      const roles = [u.role_name ?? u.role];
      const scopes = row.scope.split(" ").filter(Boolean);

      const principal: ResolvedPrincipal = {
        provider: "mcp_oauth",
        kind: "user",
        id: row.user_id,
        tenant_id: row.tenant_id,
        roles,
        scopes,
        email: u.email,
      };

      log.auth.resolved({
        provider: "mcp_oauth",
        principal_kind: "user",
        principal_id: row.user_id,
        token_id: row.id,
        tenant_id: row.tenant_id,
      });

      await maybeFlushLastUsed(db, row.id, row.tenant_id, prefix);

      return principal;
    },
  };
}
