import { and, eq, gt, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../audit/index.ts";
import type { Db } from "../db/client.ts";
import {
  connectorOauthStartGrants,
  connectorOauthStates,
  mcpOauthAccessTokens,
  mcpOauthAuthorizationCodes,
  mcpOauthClients,
  mcpOauthRefreshTokens,
  mcpOauthStates,
} from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";

const TOKEN_GRACE = sql`interval '7 days'`;

const CODE_GRACE = sql`interval '1 day'`;

const CLIENT_GRACE = sql`interval '30 days'`;

const RETIRE_AFTER = sql`interval '7 days'`;

export async function runMcpOAuthCleanup(started: Date, db: Db): Promise<void> {
  const tickId = started.toISOString();
  let access_tokens_deleted = 0;
  let refresh_tokens_deleted = 0;
  let codes_deleted = 0;
  let clients_deleted = 0;
  let retired: Array<{ id: string; client_id: string; client_name: string | null }> = [];
  let states_deleted = 0;
  let connector_oauth_start_grants_deleted = 0;
  let connector_oauth_states_deleted = 0;

  // tenant-filter:exempt — cross-tenant retention sweep
  try {
    const deleted = await db
      .delete(mcpOauthAccessTokens)
      .where(
        and(
          sql`(
            ${mcpOauthAccessTokens.expires_at} < now() - ${TOKEN_GRACE}
            OR (${mcpOauthAccessTokens.revoked_at} IS NOT NULL AND ${mcpOauthAccessTokens.revoked_at} < now() - ${TOKEN_GRACE})
          )`,
        ),
      )
      .returning({ id: mcpOauthAccessTokens.id });
    access_tokens_deleted = deleted.length;
  } catch (err) {
    logger.error({
      module: "scheduler",
      action: "mcp_oauth_cleanup.access_tokens_failed",
      msg: "MCP OAuth access-token sweep failed",
      tick_id: tickId,
      ...errorFields(err),
    });
  }

  // tenant-filter:exempt — cross-tenant retention sweep
  // Runs after access token sweep to avoid FK violations (access tokens
  // hold an optional refresh_token_id FK pointing here).
  try {
    const deleted = await db
      .delete(mcpOauthRefreshTokens)
      .where(
        sql`(
          ${mcpOauthRefreshTokens.expires_at} < now() - ${TOKEN_GRACE}
          OR (${mcpOauthRefreshTokens.revoked_at} IS NOT NULL AND ${mcpOauthRefreshTokens.revoked_at} < now() - ${TOKEN_GRACE})
        )`,
      )
      .returning({ id: mcpOauthRefreshTokens.id });
    refresh_tokens_deleted = deleted.length;
  } catch (err) {
    logger.error({
      module: "scheduler",
      action: "mcp_oauth_cleanup.refresh_tokens_failed",
      msg: "MCP OAuth refresh-token sweep failed",
      tick_id: tickId,
      ...errorFields(err),
    });
  }

  // tenant-filter:exempt — cross-tenant retention sweep
  try {
    const deleted = await db
      .delete(mcpOauthAuthorizationCodes)
      .where(lt(mcpOauthAuthorizationCodes.expires_at, sql`now() - ${CODE_GRACE}`))
      .returning({ id: mcpOauthAuthorizationCodes.id });
    codes_deleted = deleted.length;
  } catch (err) {
    logger.error({
      module: "scheduler",
      action: "mcp_oauth_cleanup.codes_failed",
      msg: "MCP OAuth authorization-code sweep failed",
      tick_id: tickId,
      ...errorFields(err),
    });
  }

  // tenant-filter:exempt — cross-tenant retention sweep
  // Only removes clients with NO durable proof-of-use: no refresh tokens, no
  // access tokens, and no authorization codes. Authorization codes alone are
  // not a durable signal — sweep 3 purges them ~1 day past expiry, so an aged
  // client that was actively used still trips a codes-only NOT EXISTS and would
  // be wrongly deleted while its live refresh tokens keep authenticating. The
  // refresh/access NOT EXISTS guards key on the persistent tokens instead;
  // sweeps 1–2 only remove expired/revoked tokens, so a live client always has
  // a row here and is protected. A genuinely abandoned DCR registration has no
  // tokens and no codes and is still GC'd after the 30-day grace, as intended.
  try {
    const deleted = await db
      .delete(mcpOauthClients)
      .where(
        and(
          lt(mcpOauthClients.created_at, sql`now() - ${CLIENT_GRACE}`),
          notExists(
            db
              .select({ id: mcpOauthRefreshTokens.id })
              .from(mcpOauthRefreshTokens) // tenant-filter:exempt — cross-tenant retention sweep; subquery is a NOT EXISTS guard only
              .where(sql`${mcpOauthRefreshTokens.client_id} = ${mcpOauthClients.client_id}`),
          ),
          notExists(
            db
              .select({ id: mcpOauthAccessTokens.id })
              .from(mcpOauthAccessTokens) // tenant-filter:exempt — cross-tenant retention sweep; subquery is a NOT EXISTS guard only
              .where(sql`${mcpOauthAccessTokens.client_id} = ${mcpOauthClients.client_id}`),
          ),
          notExists(
            db
              .select({ id: mcpOauthAuthorizationCodes.id })
              .from(mcpOauthAuthorizationCodes) // tenant-filter:exempt — cross-tenant retention sweep; subquery is a NOT EXISTS guard only
              .where(sql`${mcpOauthAuthorizationCodes.client_id} = ${mcpOauthClients.client_id}`),
          ),
        ),
      )
      .returning({ id: mcpOauthClients.id });
    clients_deleted = deleted.length;
  } catch (err) {
    logger.error({
      module: "scheduler",
      action: "mcp_oauth_cleanup.clients_failed",
      msg: "MCP OAuth unused-client sweep failed",
      tick_id: tickId,
      ...errorFields(err),
    });
  }

  // tenant-filter:exempt — mcp_oauth_clients has no tenant_id; the NOT EXISTS
  // subqueries guard over the client's own token rows, across tenants. One
  // statement, so a token minted between "is it dead?" and "retire it" cannot
  // slip past a separate read.
  try {
    const at = new Date();
    retired = await db
      .update(mcpOauthClients)
      .set({ disabled_at: at, retired_at: at })
      .where(
        and(
          eq(mcpOauthClients.registration_source, "dcr"),
          isNull(mcpOauthClients.disabled_at),
          lt(mcpOauthClients.created_at, sql`now() - ${RETIRE_AFTER}`),
          notExists(
            db
              .select({ id: mcpOauthAccessTokens.id })
              .from(mcpOauthAccessTokens) // tenant-filter:exempt — cross-tenant retention sweep; subquery is a NOT EXISTS guard only
              .where(
                and(
                  sql`${mcpOauthAccessTokens.client_id} = ${mcpOauthClients.client_id}`,
                  or(
                    and(
                      isNull(mcpOauthAccessTokens.revoked_at),
                      gt(mcpOauthAccessTokens.expires_at, sql`now()`),
                    ),
                    gt(mcpOauthAccessTokens.last_used_at, sql`now() - ${RETIRE_AFTER}`),
                  ),
                ),
              ),
          ),
          notExists(
            db
              .select({ id: mcpOauthRefreshTokens.id })
              .from(mcpOauthRefreshTokens) // tenant-filter:exempt — cross-tenant retention sweep; subquery is a NOT EXISTS guard only
              .where(
                and(
                  sql`${mcpOauthRefreshTokens.client_id} = ${mcpOauthClients.client_id}`,
                  or(
                    and(
                      isNull(mcpOauthRefreshTokens.revoked_at),
                      gt(mcpOauthRefreshTokens.expires_at, sql`now()`),
                    ),
                    gt(mcpOauthRefreshTokens.created_at, sql`now() - ${RETIRE_AFTER}`),
                  ),
                ),
              ),
          ),
          notExists(
            db
              .select({ id: mcpOauthAuthorizationCodes.id })
              .from(mcpOauthAuthorizationCodes) // tenant-filter:exempt — cross-tenant retention sweep; subquery is a NOT EXISTS guard only
              .where(
                and(
                  sql`${mcpOauthAuthorizationCodes.client_id} = ${mcpOauthClients.client_id}`,
                  gt(mcpOauthAuthorizationCodes.created_at, sql`now() - ${RETIRE_AFTER}`),
                ),
              ),
          ),
        ),
      )
      .returning({
        id: mcpOauthClients.id,
        client_id: mcpOauthClients.client_id,
        client_name: mcpOauthClients.client_name,
      });
  } catch (err) {
    logger.error({
      module: "scheduler",
      action: "mcp_oauth_cleanup.clients_retire_failed",
      msg: "MCP OAuth dead-registration retirement failed",
      tick_id: tickId,
      ...errorFields(err),
    });
  }

  if (retired.length > 0) {
    try {
      await auditAwait(
        {
          tenant_id: SYSTEM_TENANT_ID,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.MCP_OAUTH_CLIENT_RETIRED,
          resource_type: "mcp_oauth_client",
          resource_id: null,
          result: "success",
          metadata: {
            request_source: "scheduler",
            count: retired.length,
            ids: retired.map((row) => row.id),
            client_names: [
              ...new Set(retired.flatMap((row) => (row.client_name ? [row.client_name] : []))),
            ],
          },
        },
        db,
      );
    } catch (err) {
      logger.error({
        module: "scheduler",
        action: "mcp_oauth_cleanup.retire_audit_failed",
        msg: "MCP OAuth retirement audit row failed",
        tick_id: tickId,
        ...errorFields(err),
      });
    }
  }

  // tenant-filter:exempt — cross-tenant retention sweep
  // CLIENT direction (subkit → external MCP server). 10-min TTL rows; an
  // expired row is a dead in-flight flow the callback can no longer claim
  // (its DELETE … WHERE expires_at > now() guard would never match), so
  // sweep it immediately past expiry without extra grace.
  try {
    const deleted = await db
      .delete(mcpOauthStates)
      .where(lt(mcpOauthStates.expires_at, sql`now()`))
      .returning({ id: mcpOauthStates.id });
    states_deleted = deleted.length;
  } catch (err) {
    logger.error({
      module: "scheduler",
      action: "mcp_oauth_cleanup.states_failed",
      msg: "MCP OAuth client-direction state sweep failed",
      tick_id: tickId,
      ...errorFields(err),
    });
  }

  // tenant-filter:exempt — cross-tenant retention sweep.
  // Short-lived (10-min TTL); an expired row is unclaimable (the atomic
  // DELETE WHERE expires_at > now() guard would never match), so sweep
  // immediately past expiry without extra grace.
  try {
    const deleted = await db
      .delete(connectorOauthStartGrants)
      .where(lt(connectorOauthStartGrants.expires_at, sql`now()`))
      .returning({ id: connectorOauthStartGrants.id });
    connector_oauth_start_grants_deleted = deleted.length;
  } catch (err) {
    logger.error({
      module: "scheduler",
      action: "mcp_oauth_cleanup.connector_oauth_start_grants_failed",
      msg: "connector OAuth start-grant sweep failed",
      tick_id: tickId,
      ...errorFields(err),
    });
  }

  // tenant-filter:exempt — cross-tenant retention sweep.
  // The callback route atomically claims (DELETE) live rows; expired rows
  // are dead-flows that the callback will never claim. Sweep immediately
  // past expiry (same rationale as Sweep 6 above).
  try {
    const deleted = await db
      .delete(connectorOauthStates)
      .where(lt(connectorOauthStates.expires_at, sql`now()`))
      .returning({ id: connectorOauthStates.id });
    connector_oauth_states_deleted = deleted.length;
  } catch (err) {
    logger.error({
      module: "scheduler",
      action: "mcp_oauth_cleanup.connector_oauth_states_failed",
      msg: "connector OAuth states sweep failed",
      tick_id: tickId,
      ...errorFields(err),
    });
  }

  try {
    await auditAwait(
      {
        tenant_id: SYSTEM_TENANT_ID,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.MCP_OAUTH_EXPIRED_PRUNED,
        resource_type: "mcp_oauth_token",
        result: "success",
        metadata: {
          request_source: "scheduler",
          codes_deleted,
          access_tokens_deleted,
          refresh_tokens_deleted,
          clients_deleted,
          clients_retired: retired.length,
          states_deleted,
          connector_oauth_start_grants_deleted,
          connector_oauth_states_deleted,
        },
      },
      db,
    );
  } catch (err) {
    logger.error({
      module: "scheduler",
      action: "mcp_oauth_cleanup.audit_failed",
      msg: "MCP OAuth cleanup audit row failed",
      tick_id: tickId,
      ...errorFields(err),
    });
  }

  const duration_ms = Date.now() - started.getTime();
  logger.info({
    module: "scheduler",
    action: "mcp_oauth_cleanup.fired",
    msg: "MCP OAuth cleanup cron pass completed",
    tick_id: tickId,
    codes_deleted,
    access_tokens_deleted,
    refresh_tokens_deleted,
    clients_deleted,
    clients_retired: retired.length,
    states_deleted,
    connector_oauth_start_grants_deleted,
    connector_oauth_states_deleted,
    duration_ms,
  });
}
