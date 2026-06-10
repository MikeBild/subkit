// Retention sweep for the mcp_oauth_* tables.
//
// Fires every hour from the scheduler reconciler. Five DELETE sweeps run
// in dependency order so FK constraints are never violated:
//
//   1) mcp_oauth_access_tokens — expired or revoked rows older than 7 days.
//      Access tokens hold a nullable FK to mcp_oauth_refresh_tokens; deleting
//      them first removes the FK before its parent is swept.
//
//   2) mcp_oauth_refresh_tokens — expired or revoked rows older than 7 days.
//
//   3) mcp_oauth_authorization_codes — codes older than 1 day past their
//      expires_at (consumed + expired codes are dead after the TTL + grace).
//
//   4) mcp_oauth_clients — DCR clients created more than 30 days ago that
//      never completed an authorization (no row in authorization_codes).
//      Uses a NOT EXISTS subquery to detect "registered but never used".
//
//   5) mcp_oauth_states — in-flight CLIENT-direction authorization rows
//      (subkit acting as an OAuth client against an external MCP server)
//      whose `expires_at` has passed. These are short-lived (10-min TTL);
//      an expired row is a dead in-flight flow the callback can no longer
//      claim, so it is swept immediately past expiry (no extra grace).
//
// After the sweeps a single summary audit row is emitted under
// SYSTEM_TENANT_ID with the row counts from each sweep.
//
// Each sweep is wrapped in its own try/catch; a transient failure does not
// abort the remaining sweeps. The cron is scheduled at hour resolution so
// a failed tick costs at most one extra hour of table growth.

import { and, lt, notExists, sql } from "drizzle-orm";
import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../audit/index.ts";
import type { Db } from "../db/client.ts";
import {
  mcpOauthAccessTokens,
  mcpOauthAuthorizationCodes,
  mcpOauthClients,
  mcpOauthRefreshTokens,
  mcpOauthStates,
} from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";

/** Grace window for expired / revoked tokens. 7 days gives any in-flight
 *  client or audit consumer time to notice the expiry before the row
 *  disappears from the DB. */
const TOKEN_GRACE = sql`interval '7 days'`;

/** Authorization codes are short-lived (typically minutes); one extra day
 *  of grace is enough to cover any clock skew or deferred exchange. */
const CODE_GRACE = sql`interval '1 day'`;

/** DCR clients that registered but never used their first auth code are
 *  garbage-collected after 30 days. */
const CLIENT_GRACE = sql`interval '30 days'`;

/**
 * Run the four MCP OAuth retention sweeps.
 *
 * Deletes are ordered access_tokens → refresh_tokens → authorization_codes
 * → clients so FK constraints are satisfied without deferring. The clients
 * sweep has its own NOT EXISTS guard to avoid removing active clients.
 */
export async function runMcpOAuthCleanup(started: Date, db: Db): Promise<void> {
  const tickId = started.toISOString();
  let access_tokens_deleted = 0;
  let refresh_tokens_deleted = 0;
  let codes_deleted = 0;
  let clients_deleted = 0;
  let states_deleted = 0;

  // ── Sweep 1: access tokens ─────────────────────────────────────────────────
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

  // ── Sweep 2: refresh tokens ────────────────────────────────────────────────
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

  // ── Sweep 3: authorization codes ───────────────────────────────────────────
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

  // ── Sweep 4: unused DCR clients ────────────────────────────────────────────
  // tenant-filter:exempt — cross-tenant retention sweep
  // Only removes clients that registered (via DCR) but never received an
  // authorization code — i.e. the tool registered but the user never
  // completed the consent flow within the 30-day window.
  try {
    const deleted = await db
      .delete(mcpOauthClients)
      .where(
        and(
          lt(mcpOauthClients.created_at, sql`now() - ${CLIENT_GRACE}`),
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

  // ── Sweep 5: expired client-direction in-flight authorization states ──────
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

  // ── Summary audit row ──────────────────────────────────────────────────────
  // The counts (incl. states_deleted) intentionally aggregate across ALL
  // tenants under SYSTEM_TENANT_ID — SIEM authors should not expect
  // per-tenant rows for this action.
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
          states_deleted,
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
    states_deleted,
    duration_ms,
  });
}
