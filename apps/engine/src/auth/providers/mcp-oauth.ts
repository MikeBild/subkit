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
import { getConfig } from "../../config/loader.ts";
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

/**
 * RFC 8707 canonical form of a resource indicator URI.
 * Lowercases scheme+authority (the URL spec already does this on parse)
 * and normalises the path to exactly one trailing slash.
 * Pure function — no I/O — safe to target directly from unit tests.
 */
export function canonicalizeResourceUri(raw: string): string {
  try {
    const u = new URL(raw);
    // URL spec normalises scheme+host to lowercase on parse.
    // Pin exactly one trailing slash on the path component.
    const path = `${u.pathname.replace(/\/+$/, "")}/`;
    return `${u.protocol}//${u.host}${path}${u.search}${u.hash}`;
  } catch {
    // Not a parseable absolute URL — lowercase and trim as best-effort.
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
  // Fast prefix reject — let other providers handle their own prefixes
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
      actor_type: "user",
      actor_id: userId,
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

      // ── RFC 8707 resource (audience) validation ────────────────────────
      // Tokens from RFC 8707-compliant clients carry a `resource` column
      // that names the protected resource they were issued for. A mismatch
      // means the token was issued for a different server and is being
      // replayed here — reject it.
      //
      // Tokens issued before this column was populated carry null (legacy).
      // Accept them and trace at DEBUG — this fires on EVERY request for every
      // pre-RFC-8707 token, so a WARN here floods the operator log and buries
      // the genuine `audience_mismatch` denial below. Debug keeps the signal
      // available without the noise; a token-`resource` backfill is the durable
      // fix that lets the check later be enforced strictly.
      //
      // Skip the check entirely when `server.public_base_url` is empty or
      // when config has not yet been initialised (test environment, startup
      // timing) — a non-fatal config gap must never hard-block all tokens.
      let baseUrl: string | undefined;
      try {
        baseUrl = getConfig().server.public_base_url || undefined;
      } catch {
        // ConfigLoaderError: loadConfig() not yet called — skip check.
      }
      if (baseUrl) {
        const expected = canonicalizeResourceUri(`${baseUrl}/mcp`);
        if (row.resource === null) {
          // TODO(mcp-spec): backfill the `resource` column on pre-RFC-8707
          // tokens, then remove this legacy branch so audience validation is
          // enforced strictly (MCP 2025-11-25 auth: servers MUST reject tokens
          // not issued for them). Until every live token carries a resource,
          // hard-enforcing here would lock out valid legacy sessions.
          logger.debug({
            module: "auth",
            action: "mcp_oauth.audience_legacy_null",
            msg: "accepting legacy token with null resource (audience unverified)",
            token_id: row.id,
          });
        } else if (canonicalizeResourceUri(row.resource) !== expected) {
          recordAuthFailure(ip);
          log.auth.denied({ provider: "mcp_oauth", reason: "audience_mismatch", token_id: row.id });
          return null;
        }
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

      await maybeFlushLastUsed(db, row.id, row.tenant_id, prefix, row.user_id);

      return principal;
    },
  };
}
