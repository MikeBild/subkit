import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction, SYSTEM_TENANT_ID } from "../../audit/types.ts";
import type { Config } from "../../config/schema.ts";
import type { Db } from "../../db/client.ts";
import { hostedQuotaError } from "../../db/hosted-quota-errors.ts";
import {
  mcpOauthAccessTokens,
  mcpOauthAuthorizationCodes,
  mcpOauthClients,
  mcpOauthGrants,
  mcpOauthRefreshTokens,
  mcpOauthUnknownGrants,
} from "../../db/schema/index.ts";
import { retryTransient } from "../../db/transient.ts";
import {
  clientLivenessRefusal,
  type LivenessRefusal,
  livenessRefusalDescription,
} from "../liveness.ts";
import { consumeRejectedAuthorizationCode } from "./authorization-code-consumption.ts";
import {
  type RegisterClientInput,
  type RegisterClientResult,
  registerMcpClient,
} from "./client-registration.ts";
import { revokeOAuthRefreshChain } from "./refresh-chain-revocation.ts";
import { revokeOAuthRefreshTokenFamily } from "./refresh-token-revocation.ts";
import { assertOAuthTenantActive, oauthUserLiveness } from "./tenant.ts";
import { auditOAuthTokenRejected } from "./token-rejection-audit.ts";
import {
  generateAccessToken,
  generateAuthorizationCode,
  generateRefreshToken,
  sha256Hex,
  verifyS256,
} from "./tokens.ts";

export type { RegisterClientInput, RegisterClientResult } from "./client-registration.ts";

interface IssueAuthCodeInput {
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

interface ExchangeAuthCodeInput {
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

interface ExchangeRefreshInput {
  refreshToken: string;
  clientId: string;
  scope?: string | undefined;
  requestSource?: string | undefined;
}

interface McpOAuthServerOptions {
  db: Db;
  config: Config;
}

export function createMcpOAuthProvider({ db, config }: McpOAuthServerOptions) {
  const cfg = config.auth.mcp_oauth;
  const baseUrl = config.server.public_base_url;

  async function registerClient(input: RegisterClientInput): Promise<RegisterClientResult> {
    return registerMcpClient(db, config, input);
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

    await retryTransient(
      () =>
        db.transaction(async (tx) => {
          await assertOAuthTenantActive(input.tenantId, tx);
          // tenant-filter:exempt — exact global client authority locked before code issuance
          const [client] = await tx
            .select({
              id: mcpOauthClients.id,
              disabled_at: mcpOauthClients.disabled_at,
              retired_at: mcpOauthClients.retired_at,
            })
            .from(mcpOauthClients)
            .where(eq(mcpOauthClients.client_id, input.clientId))
            .for("update");
          if (!client || (client.disabled_at && !client.retired_at))
            throw Object.assign(new Error("invalid_client: OAuth client is unavailable"), {
              oauth_error: "invalid_client",
            });
          const reactivated = await tx
            .update(mcpOauthClients)
            .set({ disabled_at: null, retired_at: null })
            .where(
              and(
                eq(mcpOauthClients.client_id, input.clientId),
                isNotNull(mcpOauthClients.retired_at),
              ),
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
        }),
      {
        label: "mcp_oauth_code_issuance",
        shouldRetry: (error) => hostedQuotaError(error)?.code === "40001",
      },
    );

    return plaintext;
  }

  async function exchangeAuthorizationCode(input: ExchangeAuthCodeInput): Promise<TokenPair> {
    const requestSource = input.requestSource ?? "api";
    const codeHash = sha256Hex(input.code);

    // tenant-filter:exempt — authorization-code lookup starts from an opaque hash before its tenant is known
    const codeRows = await db
      .select()
      .from(mcpOauthAuthorizationCodes)
      .where(
        and(
          eq(mcpOauthAuthorizationCodes.code_sha256, codeHash),
          isNull(mcpOauthAuthorizationCodes.consumed_at),
        ),
      )
      .limit(1);
    const codeRow = codeRows[0];

    if (!codeRow) {
      await auditOAuthTokenRejected(db, SYSTEM_TENANT_ID, "api", "code_not_found");
      throw Object.assign(new Error("invalid_grant"), { oauth_error: "invalid_grant" });
    }
    const now = new Date();
    if (codeRow.expires_at <= now) {
      await consumeRejectedAuthorizationCode(db, codeRow.id);
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
      await consumeRejectedAuthorizationCode(db, codeRow.id);
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
      await consumeRejectedAuthorizationCode(db, codeRow.id);
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
      await consumeRejectedAuthorizationCode(db, codeRow.id);
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

    const minted = await retryTransient(
      () =>
        db.transaction(async (tx) => {
          const attemptNow = new Date();
          const claimed = await tx
            .update(mcpOauthAuthorizationCodes)
            .set({ consumed_at: sql`now()` })
            .where(
              and(
                eq(mcpOauthAuthorizationCodes.id, codeRow.id),
                isNull(mcpOauthAuthorizationCodes.consumed_at),
              ),
            )
            .returning({ id: mcpOauthAuthorizationCodes.id });
          if (!claimed[0]) return "code_claimed" as const;
          if (codeRow.expires_at <= attemptNow) return "code_expired" as const;
          const accessExpiresAt = new Date(
            attemptNow.getTime() + cfg.access_token_ttl_seconds * 1000,
          );
          const refreshExpiresAt = new Date(
            attemptNow.getTime() + cfg.refresh_token_ttl_seconds * 1000,
          );
          try {
            await assertOAuthTenantActive(codeRow.tenant_id, tx);
          } catch (error) {
            if ((error as { oauth_reason?: string }).oauth_reason === "tenant_unavailable") {
              return "tenant_unavailable" as const;
            }
            throw error;
          }
          if (await oauthUserLiveness(tx, codeRow.tenant_id, codeRow.user_id, true))
            return "user_revoked" as const;

          // tenant-filter:exempt — mcp_oauth_clients has no tenant_id
          const [client] = await tx
            .select({
              disabled_at: mcpOauthClients.disabled_at,
              retired_at: mcpOauthClients.retired_at,
            })
            .from(mcpOauthClients)
            .where(eq(mcpOauthClients.client_id, codeRow.client_id))
            .for("update");
          if (!client || (client.disabled_at && !client.retired_at))
            return "client_revoked" as const;
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
              connected_at: attemptNow,
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
        }),
      {
        label: "mcp_oauth_code_exchange",
        shouldRetry: (error) => hostedQuotaError(error)?.code === "40001",
      },
    );

    if (minted === "code_claimed" || minted === "code_expired") {
      await auditAwait(
        {
          tenant_id: minted === "code_expired" ? codeRow.tenant_id : SYSTEM_TENANT_ID,
          actor_type: "system",
          action: AuditAction.MCP_OAUTH_TOKEN_REJECTED,
          resource_type: "mcp_oauth_token",
          resource_id: null,
          result: "denied",
          metadata: {
            request_source: requestSource,
            reason: minted === "code_expired" ? "code_expired" : "code_not_found",
          },
        },
        db,
      );
      throw Object.assign(new Error("invalid_grant"), { oauth_error: "invalid_grant" });
    }
    if (minted === "tenant_unavailable") {
      await auditAwait(
        {
          tenant_id: codeRow.tenant_id,
          actor_type: "system",
          action: AuditAction.MCP_OAUTH_TOKEN_REJECTED,
          resource_type: "mcp_oauth_token",
          resource_id: null,
          result: "denied",
          metadata: { request_source: requestSource, reason: "tenant_unavailable" },
        },
        db,
      );
      throw Object.assign(new Error("invalid_grant: workspace is unavailable"), {
        oauth_error: "invalid_grant",
      });
    }
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

    const userRefusal = await oauthUserLiveness(db, refreshRow.tenant_id, refreshRow.user_id);
    // tenant-filter:exempt — mcp_oauth_clients has no tenant_id
    const clientRows = await db
      .select({ disabled_at: mcpOauthClients.disabled_at, retired_at: mcpOauthClients.retired_at })
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.client_id, refreshRow.client_id))
      .limit(1);
    const livenessRefusal: LivenessRefusal | null =
      userRefusal ?? clientLivenessRefusal(clientRows[0]);
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
      await revokeOAuthRefreshChain(
        db,
        refreshRow.id,
        refreshRow.tenant_id,
        refreshRow.user_id,
        now,
      );
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
      await revokeOAuthRefreshChain(
        db,
        refreshRow.id,
        refreshRow.tenant_id,
        refreshRow.user_id,
        now,
      );
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
              .filter((scope) => originalScopes.includes(scope)),
          ),
        ]
      : originalScopes;
    const grantedScope = grantedScopes.join(" ") || originalScopes.join(" ");

    const newRefresh = generateRefreshToken();
    const newAccess = generateAccessToken();
    try {
      await retryTransient(
        () =>
          db.transaction(async (tx) => {
            const attemptNow = new Date();
            const newRefreshExpiresAt = new Date(
              attemptNow.getTime() + cfg.refresh_token_ttl_seconds * 1000,
            );
            const newAccessExpiresAt = new Date(
              attemptNow.getTime() + cfg.access_token_ttl_seconds * 1000,
            );
            await assertOAuthTenantActive(refreshRow.tenant_id, tx);
            if (await oauthUserLiveness(tx, refreshRow.tenant_id, refreshRow.user_id, true)) {
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
            if (
              !parent ||
              parent.revoked_at ||
              parent.rotated_to_id ||
              parent.expires_at <= attemptNow
            ) {
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
              throw Object.assign(
                new Error("invalid_grant: token already rotated — chain revoked"),
                {
                  oauth_error: "invalid_grant",
                  oauth_reason: "refresh_replayed",
                },
              );
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

            await auditAwait(
              {
                tenant_id: refreshRow.tenant_id,
                actor_type: "user",
                actor_id: refreshRow.user_id,
                action: AuditAction.MCP_OAUTH_TOKEN_REFRESHED,
                resource_type: "mcp_oauth_token",
                resource_id: newAccess.prefix,
                result: "success",
                metadata: {
                  request_source: requestSource,
                  client_id: refreshRow.client_id,
                  scope: grantedScope,
                  old_prefix: refreshRow.prefix,
                  new_refresh_id: newRefreshRow.id,
                },
              },
              tx,
            );

            return { newRefreshId: newRefreshRow.id, newAccessPrefix: newAccess.prefix };
          }),
        {
          label: "mcp_oauth_refresh_rotation",
          shouldRetry: (error) => hostedQuotaError(error)?.code === "40001",
        },
      );
    } catch (txErr) {
      if ((txErr as { oauth_error?: string }).oauth_error === "invalid_grant") {
        const oauthReason = (txErr as { oauth_reason?: string }).oauth_reason ?? "refresh_replayed";
        if (oauthReason === "refresh_replayed") {
          await revokeOAuthRefreshChain(
            db,
            refreshRow.id,
            refreshRow.tenant_id,
            refreshRow.user_id,
            now,
          );
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

  return {
    registerClient,
    getClient,
    issueAuthorizationCode,
    exchangeAuthorizationCode,
    exchangeRefreshToken,
    revokeToken,
    getBaseUrl: () => baseUrl,
  };
}

export type McpOAuthProvider = ReturnType<typeof createMcpOAuthProvider>;
