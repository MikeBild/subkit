import { and, eq } from "drizzle-orm";
import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { getConfig } from "../../config/loader.ts";
import { type Db, getDb } from "../../db/client.ts";
import {
  mcpOauthAccessTokens,
  mcpOauthClients,
  roles as rolesTable,
  users,
} from "../../db/schema/index.ts";
import { sha256Hex } from "../../identity/api-key.ts";
import { log, logger } from "../../logging/logger.ts";
import { recordAuthFailure } from "../failed-auth-tracker.ts";
import { clientLivenessRefusal, userLivenessRefusal } from "../liveness.ts";
import {
  ACCESS_TOKEN_PREFIX_LITERAL,
  constantTimeHexEquals,
  TOKEN_PREFIX_LENGTH,
} from "../oauth/tokens.ts";
import type { AuthProvider, ResolvedPrincipal } from "../types.ts";

export function canonicalizeResourceUri(raw: string): string {
  try {
    const u = new URL(raw);
    const path = `${u.pathname.replace(/\/+$/, "")}/`;
    return `${u.protocol}//${u.host}${path}${u.search}${u.hash}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

const FLUSH_INTERVAL_MS = 60_000;
const lastFlush = new Map<string, number>();

function extractMcpToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  if (auth.length <= 7) return null;
  if (auth.slice(0, 7).toLowerCase() !== "bearer ") return null;
  const token = auth.slice(7).trim();
  if (!token.startsWith(ACCESS_TOKEN_PREFIX_LITERAL)) return null;
  return token;
}

async function maybeFlushLastUsed(
  db: Db,
  tokenId: string,
  tenantId: string,
  prefix: string,
  userId: string,
): Promise<void> {
  const now = Date.now();
  const last = lastFlush.get(tokenId) ?? 0;
  if (now - last < FLUSH_INTERVAL_MS) return;
  lastFlush.set(tokenId, now);

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
      actor_type: "user",
      actor_id: userId,
      action: AuditAction.MCP_OAUTH_TOKEN_USED,
      resource_type: "mcp_oauth_token",
      resource_id: tokenId,
      result: "success",
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

      const ip =
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        req.headers.get("x-real-ip") ??
        "unknown";

      if (!constantTimeHexEquals(row.token_sha256, tokenHash)) {
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
        recordAuthFailure(ip);
        log.auth.denied({ provider: "mcp_oauth", reason: "revoked", token_id: row.id });
        return null;
      }

      if (row.expires_at <= now) {
        recordAuthFailure(ip);
        log.auth.denied({ provider: "mcp_oauth", reason: "expired", token_id: row.id });
        return null;
      }

      let baseUrl: string | undefined;
      try {
        baseUrl = getConfig().server.public_base_url || undefined;
      } catch {}
      if (baseUrl) {
        const expected = canonicalizeResourceUri(`${baseUrl}/mcp`);
        if (row.resource === null) {
          recordAuthFailure(ip);
          log.auth.denied({ provider: "mcp_oauth", reason: "audience_missing", token_id: row.id });
          return null;
        } else if (canonicalizeResourceUri(row.resource) !== expected) {
          recordAuthFailure(ip);
          log.auth.denied({ provider: "mcp_oauth", reason: "audience_mismatch", token_id: row.id });
          return null;
        }
      }

      const userRows = await db
        .select({
          email: users.email,
          role_id: users.role_id,
          role_name: rolesTable.name,
          status: users.status,
          deleted_at: users.deleted_at,
        })
        .from(users)
        .leftJoin(rolesTable, eq(rolesTable.id, users.role_id))
        .where(and(eq(users.id, row.user_id), eq(users.tenant_id, row.tenant_id)))
        .limit(1);
      const u = userRows[0];
      const userRefusal = userLivenessRefusal(u);
      if (!u || userRefusal) {
        if (userRefusal && userRefusal !== "user_missing") recordAuthFailure(ip);
        log.auth.denied({
          provider: "mcp_oauth",
          reason: userRefusal ?? "user_missing",
          token_id: row.id,
        });
        return null;
      }

      // tenant-filter:exempt — mcp_oauth_clients has no tenant_id
      const clientRows = await db
        .select({
          disabled_at: mcpOauthClients.disabled_at,
          retired_at: mcpOauthClients.retired_at,
        })
        .from(mcpOauthClients)
        .where(eq(mcpOauthClients.client_id, row.client_id))
        .limit(1);
      const clientRefusal = clientLivenessRefusal(clientRows[0]);
      if (clientRefusal) {
        recordAuthFailure(ip);
        log.auth.denied({
          provider: "mcp_oauth",
          reason: clientRefusal,
          token_id: row.id,
        });
        return null;
      }

      const roles = u.role_name ? [u.role_name] : [];
      const scopes = row.scope.split(" ").filter(Boolean);

      const principal: ResolvedPrincipal = {
        provider: "mcp_oauth",
        kind: "user",
        id: row.user_id,
        tenant_id: row.tenant_id,
        roles,
        scopes,
        oauth_client_id: row.client_id,
        auth_source: { kind: "mcp_oauth", access_token_id: row.id, client_id: row.client_id },
        email: u.email,
      };

      log.auth.resolved({
        provider: "mcp_oauth",
        principal_kind: "user",
        principal_id: row.user_id,
        token_id: row.id,
        tenant_id: row.tenant_id,
        oauth_client_id: row.client_id,
      });

      await maybeFlushLastUsed(db, row.id, row.tenant_id, prefix, row.user_id);

      return principal;
    },
  };
}
