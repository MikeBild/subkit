// MCP OAuth 2.1 server provider — pure domain state machine (no HTTP).
//
// Implements the full authorization server lifecycle:
//   - Dynamic client registration (RFC 7591) — public clients only (none)
//   - Authorization code issuance with PKCE S256
//   - Code exchange (atomic single-use claim + redirect_uri match + PKCE verify)
//   - Refresh token rotation inside a transaction (revoke-chain on replay)
//   - Token revocation (RFC 7009)
//
// Every mint / rotate / revoke writes an audit_log entry.
// Only SHA-256 hashes are persisted — plaintext never touches the DB.

// ── SDK type shapes ───────────────────────────────────────────────────────────
// Import only type shapes from the MCP SDK — never runtime handlers.
import { randomBytes } from "node:crypto";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction, SYSTEM_TENANT_ID } from "../../audit/types.ts";
import type { Config } from "../../config/schema.ts";
import type { Db } from "../../db/client.ts";
import {
  mcpOauthAccessTokens,
  mcpOauthAuthorizationCodes,
  mcpOauthClients,
  mcpOauthRefreshTokens,
} from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import {
  generateAccessToken,
  generateAuthorizationCode,
  generateRefreshToken,
  sha256Hex,
  verifyS256,
} from "./tokens.ts";

export interface RegisterClientInput {
  client_name?: string | undefined;
  redirect_uris: string[];
  grant_types?: string[] | undefined;
  token_endpoint_auth_method?: string | undefined;
  scope?: string | undefined;
  software_id?: string | undefined;
  requestSource?: string | undefined;
}

export interface RegisterClientResult {
  client_id: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: string;
  scope: string;
  client_name?: string;
}

export interface IssueAuthCodeInput {
  clientId: string;
  tenantId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource?: string | undefined;
  state?: string | undefined;
  requestSource?: string | undefined;
}

export interface ExchangeAuthCodeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  requestSource?: string | undefined;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  expires_in: number;
  scope: string;
}

export interface ExchangeRefreshInput {
  refreshToken: string;
  clientId: string;
  scope?: string | undefined;
  requestSource?: string | undefined;
}

export interface McpOAuthServerOptions {
  db: Db;
  config: Config;
}

export function createMcpOAuthProvider({ db, config }: McpOAuthServerOptions) {
  const cfg = config.auth.mcp_oauth;
  const baseUrl = config.server.public_base_url;

  // ── registerClient ──────────────────────────────────────────────────────────
  async function registerClient(input: RegisterClientInput): Promise<RegisterClientResult> {
    // Only public clients (none) are supported — confidential clients dropped.
    const authMethod = input.token_endpoint_auth_method ?? "none";
    if (authMethod !== "none") {
      throw Object.assign(
        new Error("invalid_client_metadata: only token_endpoint_auth_method=none is supported"),
        { oauth_error: "invalid_client_metadata" },
      );
    }

    const clientId = randomBytes(16).toString("hex");
    const grantTypes = input.grant_types ?? ["authorization_code", "refresh_token"];
    // Deduplicate scope tokens: split on whitespace, drop empties, unique, rejoin.
    const rawScope = input.scope ?? "mcp:read";
    const scope = [...new Set(rawScope.split(/\s+/).filter(Boolean))].join(" ");
    const requestSource = input.requestSource ?? "api";

    await db.insert(mcpOauthClients).values({
      client_id: clientId,
      redirect_uris: input.redirect_uris,
      grant_types: grantTypes,
      token_endpoint_auth_method: "none",
      scope,
      client_name: input.client_name ?? null,
      software_id: input.software_id ?? null,
      registration_source: "dcr",
    });

    await auditAwait(
      {
        tenant_id: SYSTEM_TENANT_ID,
        actor_type: "system",
        action: AuditAction.MCP_OAUTH_CLIENT_REGISTERED,
        resource_type: "mcp_oauth_client",
        resource_id: clientId,
        result: "success",
        metadata: {
          request_source: requestSource,
          client_id: clientId,
          scope,
          grant_types: grantTypes,
        },
      },
      db,
    );

    logger.info({
      module: "mcp_oauth",
      action: "client.registered",
      msg: "MCP OAuth client registered",
      client_id: clientId,
    });

    return {
      client_id: clientId,
      redirect_uris: input.redirect_uris,
      grant_types: grantTypes,
      token_endpoint_auth_method: "none",
      scope,
      ...(input.client_name ? { client_name: input.client_name } : {}),
    };
  }

  // ── getClient ───────────────────────────────────────────────────────────────
  async function getClient(clientId: string): Promise<OAuthClientInformationFull | null> {
    // tenant-filter:exempt — client_id global lookup pre-tenant
    const rows = await db
      .select()
      .from(mcpOauthClients)
      .where(and(eq(mcpOauthClients.client_id, clientId), isNull(mcpOauthClients.disabled_at)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      client_id: row.client_id,
      redirect_uris: row.redirect_uris,
      grant_types: row.grant_types,
      // The DB CHECK constraint admits only "none" — public clients are
      // the only kind subkit registers.
      token_endpoint_auth_method: row.token_endpoint_auth_method as "none",
      scope: row.scope,
      ...(row.client_name ? { client_name: row.client_name } : {}),
    } satisfies OAuthClientInformationFull;
  }

  // ── issueAuthorizationCode ──────────────────────────────────────────────────
  async function issueAuthorizationCode(input: IssueAuthCodeInput): Promise<string> {
    const { plaintext, hash } = generateAuthorizationCode();
    const expiresAt = new Date(Date.now() + cfg.authorization_code_ttl_seconds * 1000);
    const requestSource = input.requestSource ?? "api";

    await db.insert(mcpOauthAuthorizationCodes).values({
      tenant_id: input.tenantId,
      client_id: input.clientId,
      user_id: input.userId,
      code_sha256: hash,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      redirect_uri: input.redirectUri,
      scope: input.scope,
      resource: input.resource ?? null,
      state: input.state ?? null,
      expires_at: expiresAt,
    });

    await auditAwait(
      {
        tenant_id: input.tenantId,
        actor_type: "user",
        actor_id: input.userId,
        action: AuditAction.MCP_OAUTH_CODE_ISSUED,
        resource_type: "mcp_oauth_code",
        resource_id: hash.slice(0, 16),
        result: "success",
        metadata: {
          request_source: requestSource,
          client_id: input.clientId,
          scope: input.scope,
        },
      },
      db,
    );

    return plaintext;
  }

  // ── exchangeAuthorizationCode ───────────────────────────────────────────────
  async function exchangeAuthorizationCode(input: ExchangeAuthCodeInput): Promise<TokenPair> {
    const requestSource = input.requestSource ?? "api";
    const codeHash = sha256Hex(input.code);

    // Atomic single-use claim: UPDATE ... WHERE consumed_at IS NULL RETURNING *
    // This prevents TOCTOU races where two concurrent requests both read an
    // unconsumed code before either marks it consumed. Zero rows → already
    // consumed or never existed → invalid_grant.
    const claimedRows = await db
      .update(mcpOauthAuthorizationCodes)
      .set({ consumed_at: sql`now()` })
      .where(
        and(
          eq(mcpOauthAuthorizationCodes.code_sha256, codeHash),
          isNull(mcpOauthAuthorizationCodes.consumed_at),
        ),
      )
      .returning();
    const codeRow = claimedRows[0];

    if (!codeRow) {
      await auditAwait(
        {
          tenant_id: SYSTEM_TENANT_ID,
          actor_type: "system",
          action: AuditAction.MCP_OAUTH_TOKEN_REJECTED,
          resource_type: "mcp_oauth_token",
          resource_id: null,
          result: "denied",
          metadata: { request_source: "api", reason: "code_not_found" },
        },
        db,
      );
      throw Object.assign(new Error("invalid_grant"), { oauth_error: "invalid_grant" });
    }

    const now = new Date();
    if (codeRow.expires_at <= now) {
      await auditAwait(
        {
          tenant_id: codeRow.tenant_id,
          actor_type: "system",
          action: AuditAction.MCP_OAUTH_TOKEN_REJECTED,
          resource_type: "mcp_oauth_token",
          resource_id: null,
          result: "denied",
          metadata: { request_source: "api", reason: "code_expired" },
        },
        db,
      );
      throw Object.assign(new Error("invalid_grant: code expired"), {
        oauth_error: "invalid_grant",
      });
    }

    if (codeRow.client_id !== input.clientId) {
      await auditAwait(
        {
          tenant_id: codeRow.tenant_id,
          actor_type: "system",
          action: AuditAction.MCP_OAUTH_TOKEN_REJECTED,
          resource_type: "mcp_oauth_token",
          resource_id: null,
          result: "denied",
          metadata: { request_source: "api", reason: "client_mismatch" },
        },
        db,
      );
      throw Object.assign(new Error("invalid_grant: client mismatch"), {
        oauth_error: "invalid_grant",
      });
    }

    // Exact redirect_uri match — critical open-redirect guard
    if (codeRow.redirect_uri !== input.redirectUri) {
      await auditAwait(
        {
          tenant_id: codeRow.tenant_id,
          actor_type: "system",
          action: AuditAction.MCP_OAUTH_TOKEN_REJECTED,
          resource_type: "mcp_oauth_token",
          resource_id: null,
          result: "denied",
          metadata: { request_source: "api", reason: "redirect_mismatch" },
        },
        db,
      );
      throw Object.assign(new Error("invalid_grant: redirect_uri mismatch"), {
        oauth_error: "invalid_grant",
      });
    }

    // PKCE S256 verification
    if (!verifyS256(input.codeVerifier, codeRow.code_challenge)) {
      await auditAwait(
        {
          tenant_id: codeRow.tenant_id,
          actor_type: "system",
          action: AuditAction.MCP_OAUTH_TOKEN_REJECTED,
          resource_type: "mcp_oauth_token",
          resource_id: null,
          result: "denied",
          metadata: { request_source: "api", reason: "pkce_mismatch" },
        },
        db,
      );
      throw Object.assign(new Error("invalid_grant: PKCE verification failed"), {
        oauth_error: "invalid_grant",
      });
    }

    const access = generateAccessToken();
    const refresh = generateRefreshToken();
    const accessExpiresAt = new Date(now.getTime() + cfg.access_token_ttl_seconds * 1000);
    const refreshExpiresAt = new Date(now.getTime() + cfg.refresh_token_ttl_seconds * 1000);

    // Insert refresh token first (access token FK)
    const [refreshRow] = await db
      .insert(mcpOauthRefreshTokens)
      .values({
        tenant_id: codeRow.tenant_id,
        client_id: codeRow.client_id,
        user_id: codeRow.user_id,
        prefix: refresh.prefix,
        token_sha256: refresh.hash,
        scope: codeRow.scope,
        expires_at: refreshExpiresAt,
      })
      .returning({ id: mcpOauthRefreshTokens.id });

    await db.insert(mcpOauthAccessTokens).values({
      tenant_id: codeRow.tenant_id,
      client_id: codeRow.client_id,
      user_id: codeRow.user_id,
      prefix: access.prefix,
      token_sha256: access.hash,
      scope: codeRow.scope,
      resource: codeRow.resource ?? null,
      refresh_token_id: refreshRow?.id ?? null,
      expires_at: accessExpiresAt,
    });

    await auditAwait(
      {
        tenant_id: codeRow.tenant_id,
        actor_type: "user",
        actor_id: codeRow.user_id,
        action: AuditAction.MCP_OAUTH_TOKEN_ISSUED,
        resource_type: "mcp_oauth_token",
        resource_id: access.prefix,
        result: "success",
        metadata: {
          request_source: requestSource,
          client_id: codeRow.client_id,
          scope: codeRow.scope,
        },
      },
      db,
    );

    return {
      access_token: access.plaintext,
      refresh_token: refresh.plaintext,
      token_type: "bearer",
      expires_in: cfg.access_token_ttl_seconds,
      scope: codeRow.scope,
    };
  }

  // ── exchangeRefreshToken ────────────────────────────────────────────────────
  async function exchangeRefreshToken(input: ExchangeRefreshInput): Promise<TokenPair> {
    const { refreshToken: refreshPlaintext, clientId, scope: requestedScope } = input;
    const requestSource = input.requestSource ?? "api";
    const refreshHash = sha256Hex(refreshPlaintext);

    // tenant-filter:exempt — prefix-based credential lookup pre-tenant
    const rows = await db
      .select()
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.token_sha256, refreshHash))
      .limit(1);
    const refreshRow = rows[0];

    if (!refreshRow) {
      await auditAwait(
        {
          tenant_id: SYSTEM_TENANT_ID,
          actor_type: "system",
          action: AuditAction.MCP_OAUTH_TOKEN_REJECTED,
          resource_type: "mcp_oauth_token",
          resource_id: null,
          result: "denied",
          metadata: { request_source: "api", reason: "refresh_not_found" },
        },
        db,
      );
      throw Object.assign(new Error("invalid_grant"), { oauth_error: "invalid_grant" });
    }

    if (refreshRow.client_id !== clientId) {
      await auditAwait(
        {
          tenant_id: refreshRow.tenant_id,
          actor_type: "system",
          action: AuditAction.MCP_OAUTH_TOKEN_REJECTED,
          resource_type: "mcp_oauth_token",
          resource_id: null,
          result: "denied",
          metadata: { request_source: "api", reason: "client_mismatch" },
        },
        db,
      );
      throw Object.assign(new Error("invalid_grant: client mismatch"), {
        oauth_error: "invalid_grant",
      });
    }

    const now = new Date();

    if (refreshRow.revoked_at && refreshRow.revoked_at <= now) {
      // A rotated/revoked token was replayed — revoke the whole chain.
      await revokeChain(refreshRow.id, refreshRow.tenant_id, refreshRow.user_id, now);
      await auditAwait(
        {
          tenant_id: refreshRow.tenant_id,
          actor_type: "system",
          action: AuditAction.MCP_OAUTH_TOKEN_REJECTED,
          resource_type: "mcp_oauth_token",
          resource_id: null,
          result: "denied",
          metadata: { request_source: "api", reason: "refresh_replayed" },
        },
        db,
      );
      throw Object.assign(new Error("invalid_grant: token replay detected — chain revoked"), {
        oauth_error: "invalid_grant",
      });
    }

    if (refreshRow.rotated_to_id) {
      // Already rotated — replay attack; revoke the chain.
      await revokeChain(refreshRow.id, refreshRow.tenant_id, refreshRow.user_id, now);
      await auditAwait(
        {
          tenant_id: refreshRow.tenant_id,
          actor_type: "system",
          action: AuditAction.MCP_OAUTH_TOKEN_REJECTED,
          resource_type: "mcp_oauth_token",
          resource_id: null,
          result: "denied",
          metadata: { request_source: "api", reason: "refresh_replayed" },
        },
        db,
      );
      throw Object.assign(new Error("invalid_grant: token already rotated — chain revoked"), {
        oauth_error: "invalid_grant",
      });
    }

    if (refreshRow.expires_at <= now) {
      await auditAwait(
        {
          tenant_id: refreshRow.tenant_id,
          actor_type: "system",
          action: AuditAction.MCP_OAUTH_TOKEN_REJECTED,
          resource_type: "mcp_oauth_token",
          resource_id: null,
          result: "denied",
          metadata: { request_source: "api", reason: "refresh_expired" },
        },
        db,
      );
      throw Object.assign(new Error("invalid_grant: refresh token expired"), {
        oauth_error: "invalid_grant",
      });
    }

    // Scope downgrade only — cannot expand beyond original grant. A scope is a
    // SET: dedup both the stored grant and the client-requested narrowing so a
    // client that echoes back the scope it received cannot accumulate duplicate
    // entries across rotations (the multiset would otherwise grow unbounded).
    const originalScopes = [...new Set(refreshRow.scope.split(" ").filter(Boolean))];
    const grantedScopes = requestedScope
      ? [
          ...new Set(
            requestedScope
              .split(" ")
              .filter(Boolean)
              .filter((s) => originalScopes.includes(s)),
          ),
        ]
      : originalScopes;
    const grantedScope = grantedScopes.join(" ") || originalScopes.join(" ");

    // Rotate inside a transaction to prevent duplicate-use races.
    // Insert new refresh token first, then atomically claim the old one
    // (rotated_to_id IS NULL guard). Zero rows on the update → concurrent
    // rotation won the race → rollback → invalid_grant.
    const newRefresh = generateRefreshToken();
    const newAccess = generateAccessToken();
    const newRefreshExpiresAt = new Date(now.getTime() + cfg.refresh_token_ttl_seconds * 1000);
    const newAccessExpiresAt = new Date(now.getTime() + cfg.access_token_ttl_seconds * 1000);

    // The rotation race branch throws invalid_grant from inside the transaction.
    // Catching it here (outside the tx) lets us emit the audit row on the outer
    // db connection — emitting inside the tx would roll the audit back with it.
    let txResult: { newRefreshId: string; newAccessPrefix: string };
    try {
      txResult = await db.transaction(async (tx) => {
        const insertedRefreshRows = await tx
          .insert(mcpOauthRefreshTokens)
          .values({
            tenant_id: refreshRow.tenant_id,
            client_id: refreshRow.client_id,
            user_id: refreshRow.user_id,
            prefix: newRefresh.prefix,
            token_sha256: newRefresh.hash,
            scope: grantedScope,
            expires_at: newRefreshExpiresAt,
          })
          .returning({ id: mcpOauthRefreshTokens.id });
        const newRefreshRow = insertedRefreshRows[0];
        if (!newRefreshRow) {
          throw new Error("server_error: failed to insert refresh token");
        }

        // Atomic claim: only succeeds if old token hasn't been rotated yet
        const claimed = await tx
          .update(mcpOauthRefreshTokens)
          .set({ rotated_to_id: newRefreshRow.id })
          .where(
            and(
              eq(mcpOauthRefreshTokens.id, refreshRow.id),
              isNull(mcpOauthRefreshTokens.rotated_to_id),
            ),
          )
          .returning({ id: mcpOauthRefreshTokens.id });

        if (claimed.length === 0) {
          tx.rollback();
          throw Object.assign(new Error("invalid_grant: token already rotated — chain revoked"), {
            oauth_error: "invalid_grant",
          });
        }

        await tx.insert(mcpOauthAccessTokens).values({
          tenant_id: refreshRow.tenant_id,
          client_id: refreshRow.client_id,
          user_id: refreshRow.user_id,
          prefix: newAccess.prefix,
          token_sha256: newAccess.hash,
          scope: grantedScope,
          refresh_token_id: newRefreshRow.id,
          expires_at: newAccessExpiresAt,
        });

        return { newRefreshId: newRefreshRow.id, newAccessPrefix: newAccess.prefix };
      });
    } catch (txErr) {
      if ((txErr as { oauth_error?: string }).oauth_error === "invalid_grant") {
        await auditAwait(
          {
            tenant_id: refreshRow.tenant_id,
            actor_type: "system",
            action: AuditAction.MCP_OAUTH_TOKEN_REJECTED,
            resource_type: "mcp_oauth_token",
            resource_id: null,
            result: "denied",
            metadata: { request_source: "api", reason: "refresh_replayed" },
          },
          db,
        );
      }
      throw txErr;
    }
    const { newRefreshId, newAccessPrefix } = txResult;

    await auditAwait(
      {
        tenant_id: refreshRow.tenant_id,
        actor_type: "user",
        actor_id: refreshRow.user_id,
        action: AuditAction.MCP_OAUTH_TOKEN_REFRESHED,
        resource_type: "mcp_oauth_token",
        resource_id: newAccessPrefix,
        result: "success",
        metadata: {
          request_source: requestSource,
          client_id: refreshRow.client_id,
          scope: grantedScope,
          old_prefix: refreshRow.prefix,
          new_refresh_id: newRefreshId,
        },
      },
      db,
    );

    return {
      access_token: newAccess.plaintext,
      refresh_token: newRefresh.plaintext,
      token_type: "bearer",
      expires_in: cfg.access_token_ttl_seconds,
      scope: grantedScope,
    };
  }

  // ── revokeToken ─────────────────────────────────────────────────────────────
  async function revokeToken(token: string, requestSource = "api"): Promise<void> {
    const tokenHash = sha256Hex(token);
    const now = new Date();

    // Try access token first.
    // tenant-filter:exempt — revocation lookup by opaque token sha256, pre-tenant
    const accessRows = await db
      .select({
        id: mcpOauthAccessTokens.id,
        tenant_id: mcpOauthAccessTokens.tenant_id,
        user_id: mcpOauthAccessTokens.user_id,
        client_id: mcpOauthAccessTokens.client_id,
      })
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.token_sha256, tokenHash))
      .limit(1);
    const accessRow = accessRows[0];
    if (accessRow) {
      await db
        .update(mcpOauthAccessTokens)
        .set({ revoked_at: now })
        .where(eq(mcpOauthAccessTokens.id, accessRow.id));
      await auditAwait(
        {
          tenant_id: accessRow.tenant_id,
          actor_type: "user",
          actor_id: accessRow.user_id,
          action: AuditAction.MCP_OAUTH_TOKEN_REVOKED,
          resource_type: "mcp_oauth_token",
          resource_id: accessRow.id,
          result: "success",
          metadata: {
            request_source: requestSource,
            client_id: accessRow.client_id,
            kind: "access",
          },
        },
        db,
      );
      return;
    }

    // Try refresh token.
    // tenant-filter:exempt — revocation lookup by opaque token sha256, pre-tenant
    const refreshRows = await db
      .select({
        id: mcpOauthRefreshTokens.id,
        tenant_id: mcpOauthRefreshTokens.tenant_id,
        user_id: mcpOauthRefreshTokens.user_id,
        client_id: mcpOauthRefreshTokens.client_id,
      })
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.token_sha256, tokenHash))
      .limit(1);
    const refreshRow = refreshRows[0];
    if (refreshRow) {
      await db
        .update(mcpOauthRefreshTokens)
        .set({ revoked_at: now })
        .where(eq(mcpOauthRefreshTokens.id, refreshRow.id));
      await auditAwait(
        {
          tenant_id: refreshRow.tenant_id,
          actor_type: "user",
          actor_id: refreshRow.user_id,
          action: AuditAction.MCP_OAUTH_TOKEN_REVOKED,
          resource_type: "mcp_oauth_token",
          resource_id: refreshRow.id,
          result: "success",
          metadata: {
            request_source: requestSource,
            client_id: refreshRow.client_id,
            kind: "refresh",
          },
        },
        db,
      );
    }
    // RFC 7009: silently succeed if token not found
  }

  // ── revokeChain (internal) ──────────────────────────────────────────────────
  // Revokes the entire refresh-token chain when a replayed/rotated token is
  // detected. Uses a bidirectional WITH RECURSIVE CTE to walk rotated_to_id
  // forward to root and forward to all descendants, then bulk-revokes every
  // refresh-token node and every access token in the chain.
  // actor_type is "system" — replay-triggered revocation is system-initiated (S10b).
  async function revokeChain(
    refreshId: string,
    tenantId: string,
    userId: string,
    now: Date,
  ): Promise<void> {
    // Bulk-revoke all refresh tokens in the chain via recursive CTE.
    // UNION (not UNION ALL) is required here — the bidirectional walk
    // (rotated_to_id forward + backward) would otherwise cycle infinitely
    // since each direction re-discovers the other. UNION deduplicates so
    // the recursion terminates once no new distinct (id, rotated_to_id)
    // rows are added.
    await db.execute(sql`
      WITH RECURSIVE chain AS (
        SELECT id, rotated_to_id
        FROM mcp_oauth_refresh_tokens
        WHERE id = ${refreshId}
        UNION
        SELECT r.id, r.rotated_to_id
        FROM mcp_oauth_refresh_tokens r
        INNER JOIN chain c ON r.id = c.rotated_to_id OR c.id = r.rotated_to_id
        WHERE r.revoked_at IS NULL
      )
      UPDATE mcp_oauth_refresh_tokens
      SET revoked_at = ${now}
      WHERE id IN (SELECT id FROM chain)
        AND revoked_at IS NULL
    `);

    // Revoke all access tokens associated with any token in the chain.
    await db.execute(sql`
      WITH RECURSIVE chain AS (
        SELECT id, rotated_to_id
        FROM mcp_oauth_refresh_tokens
        WHERE id = ${refreshId}
        UNION
        SELECT r.id, r.rotated_to_id
        FROM mcp_oauth_refresh_tokens r
        INNER JOIN chain c ON r.id = c.rotated_to_id OR c.id = r.rotated_to_id
      )
      UPDATE mcp_oauth_access_tokens
      SET revoked_at = ${now}
      WHERE refresh_token_id IN (SELECT id FROM chain)
        AND revoked_at IS NULL
    `);

    await auditAwait(
      {
        tenant_id: tenantId,
        // System-initiated, replay-triggered revocation — no human actor.
        // Per audit/actor.ts, actor_type "system" carries actor_id: null;
        // the affected user is recorded in metadata instead.
        actor_type: "system",
        actor_id: null,
        action: AuditAction.MCP_OAUTH_TOKEN_REVOKED,
        resource_type: "mcp_oauth_token",
        resource_id: refreshId,
        result: "success",
        metadata: {
          request_source: "api",
          reason: "replay_detected",
          chain_revoked: true,
          affected_user_id: userId,
        },
      },
      db,
    );

    logger.warn({
      module: "mcp_oauth",
      action: "token.chain_revoked",
      msg: "refresh token replay detected — chain revoked",
      refresh_token_id: refreshId,
      tenant_id: tenantId,
    });
  }

  // Expose the public_base_url for route use
  function getBaseUrl(): string {
    return baseUrl;
  }

  return {
    registerClient,
    getClient,
    issueAuthorizationCode,
    exchangeAuthorizationCode,
    exchangeRefreshToken,
    revokeToken,
    getBaseUrl,
  };
}

export type McpOAuthProvider = ReturnType<typeof createMcpOAuthProvider>;
