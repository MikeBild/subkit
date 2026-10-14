import { randomBytes } from "node:crypto";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction, SYSTEM_TENANT_ID } from "../../audit/types.ts";
import type { Config } from "../../config/schema.ts";
import type { Db } from "../../db/client.ts";
import {
  mcpOauthAccessTokens,
  mcpOauthAuthorizationCodes,
  mcpOauthClients,
  mcpOauthGrants,
  mcpOauthRefreshTokens,
  mcpOauthUnknownGrants,
  users,
} from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import {
  clientLivenessRefusal,
  type LivenessRefusal,
  livenessRefusalDescription,
  userLivenessRefusal,
} from "../liveness.ts";
import { revokeOAuthRefreshTokenFamily } from "./refresh-token-revocation.ts";
import {
  generateAccessToken,
  generateAuthorizationCode,
  generateRefreshToken,
  sha256Hex,
  verifyS256,
} from "./tokens.ts";

export interface RegisterClientInput {
  client_name?: string | undefined;
  client_uri?: string | undefined;
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
  client_uri?: string;
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

  async function registerClient(input: RegisterClientInput): Promise<RegisterClientResult> {
    const authMethod = input.token_endpoint_auth_method ?? "none";
    if (authMethod !== "none") {
      throw Object.assign(
        new Error("invalid_client_metadata: only token_endpoint_auth_method=none is supported"),
        { oauth_error: "invalid_client_metadata" },
      );
    }

    const clientId = randomBytes(16).toString("hex");
    const grantTypes = input.grant_types ?? ["authorization_code", "refresh_token"];
    const rawScope = input.scope ?? (cfg.scopes_supported.join(" ") || "mcp:read");
    const scope = [...new Set(rawScope.split(/\s+/).filter(Boolean))].join(" ");
    const requestSource = input.requestSource ?? "api";

    await db.insert(mcpOauthClients).values({
      client_id: clientId,
      redirect_uris: input.redirect_uris,
      grant_types: grantTypes,
      token_endpoint_auth_method: "none",
      scope,
      client_name: input.client_name ?? null,
      client_uri: input.client_uri ?? null,
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
      ...(input.client_uri ? { client_uri: input.client_uri } : {}),
    };
  }

  async function getClient(clientId: string): Promise<OAuthClientInformationFull | null> {
    // tenant-filter:exempt — client_id global lookup pre-tenant
    const rows = await db
      .select()
      .from(mcpOauthClients)
      .where(
        and(
          eq(mcpOauthClients.client_id, clientId),
          or(isNull(mcpOauthClients.disabled_at), isNotNull(mcpOauthClients.retired_at)),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      client_id: row.client_id,
      redirect_uris: row.redirect_uris,
      grant_types: row.grant_types,
      token_endpoint_auth_method: row.token_endpoint_auth_method as "none",
      scope: row.scope,
      ...(row.client_name ? { client_name: row.client_name } : {}),
      ...(row.client_uri ? { client_uri: row.client_uri } : {}),
    } satisfies OAuthClientInformationFull;
  }

  async function issueAuthorizationCode(input: IssueAuthCodeInput): Promise<string> {
    const { plaintext, hash } = generateAuthorizationCode();
    const expiresAt = new Date(Date.now() + cfg.authorization_code_ttl_seconds * 1000);
    const requestSource = input.requestSource ?? "api";

    await db.transaction(async (tx) => {
      // tenant-filter:exempt — mcp_oauth_clients has no tenant_id
      const reactivated = await tx
        .update(mcpOauthClients)
        .set({ disabled_at: null, retired_at: null })
        .where(
          and(eq(mcpOauthClients.client_id, input.clientId), isNotNull(mcpOauthClients.retired_at)),
        )
        .returning({ id: mcpOauthClients.id });
      if (reactivated[0]) {
        await auditAwait(
          {
            tenant_id: input.tenantId,
            actor_type: "user",
            actor_id: input.userId,
            action: AuditAction.MCP_OAUTH_CLIENT_REACTIVATED,
            resource_type: "mcp_oauth_client",
            resource_id: input.clientId,
            result: "success",
            metadata: { request_source: requestSource, client_id: input.clientId },
          },
          tx,
        );
      }

      await tx.insert(mcpOauthAuthorizationCodes).values({
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
        tx,
      );
    });

    return plaintext;
  }

  async function exchangeAuthorizationCode(input: ExchangeAuthCodeInput): Promise<TokenPair> {
    const requestSource = input.requestSource ?? "api";
    const codeHash = sha256Hex(input.code);

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

    const minted = await db.transaction(async (tx) => {
      const userRows = await tx
        .select({ status: users.status, deleted_at: users.deleted_at })
        .from(users)
        .where(and(eq(users.id, codeRow.user_id), eq(users.tenant_id, codeRow.tenant_id)))
        .for("update");
      if (userLivenessRefusal(userRows[0])) return "user_revoked" as const;

      // tenant-filter:exempt — mcp_oauth_clients has no tenant_id
      const [client] = await tx
        .select({
          disabled_at: mcpOauthClients.disabled_at,
          retired_at: mcpOauthClients.retired_at,
        })
        .from(mcpOauthClients)
        .where(eq(mcpOauthClients.client_id, codeRow.client_id))
        .for("update");
      if (client?.disabled_at && !client.retired_at) return "client_revoked" as const;
      if (client?.retired_at) {
        await tx
          .update(mcpOauthClients)
          .set({ disabled_at: null, retired_at: null })
          .where(
            and(
              eq(mcpOauthClients.client_id, codeRow.client_id),
              isNotNull(mcpOauthClients.retired_at),
            ),
          );
        await auditAwait(
          {
            tenant_id: codeRow.tenant_id,
            actor_type: "user",
            actor_id: codeRow.user_id,
            action: AuditAction.MCP_OAUTH_CLIENT_REACTIVATED,
            resource_type: "mcp_oauth_client",
            resource_id: codeRow.client_id,
            result: "success",
            metadata: { request_source: requestSource, client_id: codeRow.client_id },
          },
          tx,
        );
      }

      const [grant] = await tx
        .insert(mcpOauthGrants)
        .values({
          tenant_id: codeRow.tenant_id,
          client_id: codeRow.client_id,
          user_id: codeRow.user_id,
          connected_at: now,
        })
        .returning({ id: mcpOauthGrants.id });

      if (!grant) throw new Error("oauth_grant_insert_failed");

      const [refreshRow] = await tx
        .insert(mcpOauthRefreshTokens)
        .values({
          tenant_id: codeRow.tenant_id,
          client_id: codeRow.client_id,
          user_id: codeRow.user_id,
          grant_id: grant.id,
          prefix: refresh.prefix,
          token_sha256: refresh.hash,
          scope: codeRow.scope,
          resource: codeRow.resource ?? null,
          expires_at: refreshExpiresAt,
        })
        .returning({ id: mcpOauthRefreshTokens.id });

      await tx.insert(mcpOauthAccessTokens).values({
        tenant_id: codeRow.tenant_id,
        client_id: codeRow.client_id,
        user_id: codeRow.user_id,
        grant_id: grant.id,
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
        tx,
      );
      return "minted" as const;
    });

    if (minted === "client_revoked") {
      await auditAwait(
        {
          tenant_id: codeRow.tenant_id,
          actor_type: "system",
          action: AuditAction.MCP_OAUTH_TOKEN_REJECTED,
          resource_type: "mcp_oauth_token",
          resource_id: null,
          result: "denied",
          metadata: {
            request_source: requestSource,
            reason: "client_revoked",
            client_id: codeRow.client_id,
          },
        },
        db,
      );
      throw Object.assign(new Error("invalid_grant: client_revoked"), {
        oauth_error: "invalid_grant",
        oauth_error_description: livenessRefusalDescription("client_revoked"),
      });
    }
    if (minted === "user_revoked") {
      await auditAwait(
        {
          tenant_id: codeRow.tenant_id,
          actor_type: "system",
          action: AuditAction.MCP_OAUTH_TOKEN_REJECTED,
          resource_type: "mcp_oauth_token",
          resource_id: null,
          result: "denied",
          metadata: { request_source: requestSource, reason: "user_disabled" },
        },
        db,
      );
      throw Object.assign(new Error("invalid_grant: user revoked"), {
        oauth_error: "invalid_grant",
      });
    }

    return {
      access_token: access.plaintext,
      refresh_token: refresh.plaintext,
      token_type: "bearer",
      expires_in: cfg.access_token_ttl_seconds,
      scope: codeRow.scope,
    };
  }

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

    // tenant-filter:exempt — the refresh row's tenant_id IS the filter
    const userRows = await db
      .select({ status: users.status, deleted_at: users.deleted_at })
      .from(users)
      .where(and(eq(users.id, refreshRow.user_id), eq(users.tenant_id, refreshRow.tenant_id)))
      .limit(1);
    // tenant-filter:exempt — mcp_oauth_clients has no tenant_id
    const clientRows = await db
      .select({ disabled_at: mcpOauthClients.disabled_at, retired_at: mcpOauthClients.retired_at })
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.client_id, refreshRow.client_id))
      .limit(1);
    const livenessRefusal: LivenessRefusal | null =
      userLivenessRefusal(userRows[0]) ?? clientLivenessRefusal(clientRows[0]);
    if (livenessRefusal) {
      await db.transaction((tx) =>
        revokeOAuthRefreshTokenFamily(tx, refreshRow.id, refreshRow.tenant_id, now),
      );
      await auditAwait(
        {
          tenant_id: refreshRow.tenant_id,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.MCP_OAUTH_TOKEN_REJECTED,
          resource_type: "mcp_oauth_token",
          resource_id: null,
          result: "denied",
          metadata: {
            request_source: requestSource,
            reason: livenessRefusal,
            client_id: refreshRow.client_id,
            affected_user_id: refreshRow.user_id,
          },
        },
        db,
      );
      throw Object.assign(new Error(`invalid_grant: ${livenessRefusal}`), {
        oauth_error: "invalid_grant",
        oauth_error_description: livenessRefusalDescription(livenessRefusal),
      });
    }

    if (refreshRow.revoked_at && refreshRow.revoked_at <= now) {
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

    const newRefresh = generateRefreshToken();
    const newAccess = generateAccessToken();
    const newRefreshExpiresAt = new Date(now.getTime() + cfg.refresh_token_ttl_seconds * 1000);
    const newAccessExpiresAt = new Date(now.getTime() + cfg.access_token_ttl_seconds * 1000);

    let txResult: { newRefreshId: string; newAccessPrefix: string };
    try {
      txResult = await db.transaction(async (tx) => {
        const lockedUserRows = await tx
          .select({ status: users.status, deleted_at: users.deleted_at })
          .from(users)
          .where(and(eq(users.id, refreshRow.user_id), eq(users.tenant_id, refreshRow.tenant_id)))
          .for("update");
        if (userLivenessRefusal(lockedUserRows[0])) {
          throw Object.assign(new Error("invalid_grant: user revoked"), {
            oauth_error: "invalid_grant",
            oauth_reason: "user_disabled",
          });
        }

        // tenant-filter:exempt — OAuth clients are platform-global and have no tenant_id.
        const [lockedClient] = await tx
          .select({
            disabled_at: mcpOauthClients.disabled_at,
            retired_at: mcpOauthClients.retired_at,
          })
          .from(mcpOauthClients)
          .where(eq(mcpOauthClients.client_id, refreshRow.client_id))
          .for("update");
        if (!lockedClient || clientLivenessRefusal(lockedClient)) {
          throw Object.assign(new Error("invalid_grant: client revoked"), {
            oauth_error: "invalid_grant",
            oauth_reason: "client_revoked",
          });
        }
        if (refreshRow.grant_id) {
          const [grant] = await tx
            .select({ revoked_at: mcpOauthGrants.revoked_at })
            .from(mcpOauthGrants)
            .where(
              and(
                eq(mcpOauthGrants.id, refreshRow.grant_id),
                eq(mcpOauthGrants.tenant_id, refreshRow.tenant_id),
                eq(mcpOauthGrants.client_id, refreshRow.client_id),
                eq(mcpOauthGrants.user_id, refreshRow.user_id),
              ),
            )
            .for("update");
          if (!grant || grant.revoked_at) {
            throw Object.assign(new Error("invalid_grant: OAuth grant revoked"), {
              oauth_error: "invalid_grant",
              oauth_reason: "grant_revoked",
            });
          }
        }

        const [parent] = await tx
          .select({
            revoked_at: mcpOauthRefreshTokens.revoked_at,
            rotated_to_id: mcpOauthRefreshTokens.rotated_to_id,
            expires_at: mcpOauthRefreshTokens.expires_at,
          })
          .from(mcpOauthRefreshTokens)
          .where(
            and(
              eq(mcpOauthRefreshTokens.id, refreshRow.id),
              eq(mcpOauthRefreshTokens.tenant_id, refreshRow.tenant_id),
              eq(mcpOauthRefreshTokens.client_id, refreshRow.client_id),
              eq(mcpOauthRefreshTokens.user_id, refreshRow.user_id),
            ),
          )
          .for("update");
        if (!parent || parent.revoked_at || parent.rotated_to_id || parent.expires_at <= now) {
          throw Object.assign(new Error("invalid_grant: refresh token is no longer live"), {
            oauth_error: "invalid_grant",
            oauth_reason: parent?.rotated_to_id ? "refresh_replayed" : "refresh_not_live",
          });
        }

        if (!refreshRow.grant_id) {
          await tx
            .insert(mcpOauthUnknownGrants)
            .values({ tenant_id: refreshRow.tenant_id, client_id: refreshRow.client_id })
            .onConflictDoNothing();
        }

        const insertedRefreshRows = await tx
          .insert(mcpOauthRefreshTokens)
          .values({
            tenant_id: refreshRow.tenant_id,
            client_id: refreshRow.client_id,
            user_id: refreshRow.user_id,
            grant_id: refreshRow.grant_id,
            prefix: newRefresh.prefix,
            token_sha256: newRefresh.hash,
            scope: grantedScope,
            resource: refreshRow.resource ?? null,
            expires_at: newRefreshExpiresAt,
          })
          .returning({ id: mcpOauthRefreshTokens.id });
        const newRefreshRow = insertedRefreshRows[0];
        if (!newRefreshRow) {
          throw new Error("server_error: failed to insert refresh token");
        }

        const claimed = await tx
          .update(mcpOauthRefreshTokens)
          .set({ rotated_to_id: newRefreshRow.id })
          .where(
            and(
              eq(mcpOauthRefreshTokens.id, refreshRow.id),
              isNull(mcpOauthRefreshTokens.rotated_to_id),
              isNull(mcpOauthRefreshTokens.revoked_at),
            ),
          )
          .returning({ id: mcpOauthRefreshTokens.id });

        if (claimed.length === 0) {
          throw Object.assign(new Error("invalid_grant: token already rotated — chain revoked"), {
            oauth_error: "invalid_grant",
            oauth_reason: "refresh_replayed",
          });
        }

        await tx.insert(mcpOauthAccessTokens).values({
          tenant_id: refreshRow.tenant_id,
          client_id: refreshRow.client_id,
          user_id: refreshRow.user_id,
          grant_id: refreshRow.grant_id,
          prefix: newAccess.prefix,
          token_sha256: newAccess.hash,
          scope: grantedScope,
          resource: refreshRow.resource ?? null,
          refresh_token_id: newRefreshRow.id,
          expires_at: newAccessExpiresAt,
        });

        return { newRefreshId: newRefreshRow.id, newAccessPrefix: newAccess.prefix };
      });
    } catch (txErr) {
      if ((txErr as { oauth_error?: string }).oauth_error === "invalid_grant") {
        const oauthReason = (txErr as { oauth_reason?: string }).oauth_reason ?? "refresh_replayed";
        if (oauthReason === "refresh_replayed") {
          await revokeChain(refreshRow.id, refreshRow.tenant_id, refreshRow.user_id, now);
        }
        await auditAwait(
          {
            tenant_id: refreshRow.tenant_id,
            actor_type: "system",
            action: AuditAction.MCP_OAUTH_TOKEN_REJECTED,
            resource_type: "mcp_oauth_token",
            resource_id: null,
            result: "denied",
            metadata: {
              request_source: requestSource,
              reason: oauthReason,
            },
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

  async function revokeToken(token: string, requestSource = "api"): Promise<void> {
    const tokenHash = sha256Hex(token);
    const now = new Date();

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
      await db.transaction((tx) =>
        revokeOAuthRefreshTokenFamily(tx, refreshRow.id, refreshRow.tenant_id, now),
      );
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
  }

  async function revokeChain(
    refreshId: string,
    tenantId: string,
    userId: string,
    now: Date,
  ): Promise<void> {
    await db.transaction((tx) => revokeOAuthRefreshTokenFamily(tx, refreshId, tenantId, now));

    await auditAwait(
      {
        tenant_id: tenantId,
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
