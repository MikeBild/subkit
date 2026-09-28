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
//      left no durable footprint: no refresh tokens, no access tokens, and
//      no authorization codes. The "was this client ever used" signal must
//      be a DURABLE record. Authorization codes are NOT durable — sweep 3
//      above purges them ~1 day past expiry, so for any client older than
//      30 days the codes are always gone; keying the guard on codes alone
//      deletes every aged client, including ones in active daily use whose
//      live refresh tokens still authenticate. The guard therefore checks
//      all three proof-of-use tables via NOT EXISTS.
//
//   4b) mcp_oauth_clients — RETIRED (disabled, reversibly): a DCR registration created
//      more than 7 days ago that nobody holds a valid grant for (no live
//      access or refresh token — the same predicate the Cockpit's
//      "Verbundene Anwendungen" reads) and that shows no use in the last 7
//      days (no access token used, no refresh token minted, no authorization
//      code issued). `disabled_at` and `retired_at` are set together; the
//      registration leaves the list and comes back the moment a person
//      completes an authorization for it (server-provider.ts). A client that
//      registers on every run and never returns — a deploy verifier — would
//      otherwise bury the real applications under hundreds of rows no one can
//      use. Manual registrations are never retired. Retirement itself
//      deletes nothing; sweep 4 above still removes, 30 days after
//      registration, any client with no token or code rows left — a retired
//      one included. After that the host has to register again, as before.
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

/** A DCR registration with no valid grant and no use for this long is retired. */
const RETIRE_AFTER = sql`interval '7 days'`;

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
  let retired: Array<{ id: string; client_id: string; client_name: string | null }> = [];
  let states_deleted = 0;
  let connector_oauth_start_grants_deleted = 0;
  let connector_oauth_states_deleted = 0;

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

  // ── Sweep 4b: retire dead DCR registrations ───────────────────────────────
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
          // A valid grant (a live access token — listClientApprovals), or an
          // access token used within the window.
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
          // A valid grant (a live refresh token), or one minted within the
          // window — a rotation is use.
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
          // An authorization in flight, or one just completed.
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

  // One row per sweep that retired anything, naming what it retired — the
  // Cockpit's count of hidden registrations has its reason in the trail.
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

  // ── Sweep 6: expired connector OAuth start grants ─────────────────────────
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

  // ── Sweep 7: expired connector OAuth states ────────────────────────────────
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
