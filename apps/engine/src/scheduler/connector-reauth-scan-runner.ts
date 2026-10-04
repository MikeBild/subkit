// Per-tenant runner for the scheduler's proactive connector re-auth scan.
//
// Extracted out of `reconciler.ts` (same split as `proactive-drift-scan-runner.ts`)
// to keep that file under the 1000-LOC ceiling. The reconciler owns the
// cadence + CAS-stamp logic; this module owns the per-tenant sweep: select
// candidate connectors, perform a driver-native probe via `probeConnector`,
// and atomically flag connectors whose credentials are rejected.
//
// Flag predicate: `result.ok === false && result.error_code` is either
// "credential_invalid" or "credential_expired". Every other outcome
// (ok:true, credential_missing, scope_insufficient, remote_*, network
// throw, unknown_upstream_error) is left alone — a transient DNS or TCP
// failure, a missing config, or an upstream outage must not be misread
// as a credential rejection.
//
// The probe sweep alone is blind to already-known failures: the candidate
// filter excludes flagged (needs_reauth) and circuit-open connectors, so a
// connector that keeps 401-ing scheduled workflows at runtime never appears
// in the probe counters. A second phase therefore sweeps runtime evidence
// (execution_steps auth_failed errors) and escalates persistent streaks on
// schedule-bound workflows to `level:"error"` — see
// scanScheduledWorkflowAuthFailureStreaks below.
//
// A third sweep, `runOAuth2RefreshKeepAliveForTenant`, rides the same
// hourly claim: it enqueues proactive `connector.refresh-oauth` jobs for
// oauth2 credentials idle for days, so refresh tokens survive IdP
// idle-expiry on connectors that neither traffic nor probes exercise.
//
// DRIVER `mcp` IS NOT PROBED HERE, and that is a hard exclusion rather than
// a tuning choice. For every other driver a probe is one cheap stateless
// request. For `mcp` it is a full session handshake through the client pool
// (`connectServerById`), which by design CLEARS the connector's armed
// backoff window, negotiates `initialize`, lists the remote's tools, and on
// failure writes `connectors.last_error`, arms a fresh backoff and flips
// health to `degraded`. Sweeping that hourly across every remote a tenant
// registered turns a health check into a load generator against third-party
// servers, and — worse — lets the sweep itself park a server the tenant
// never called, so the scan would report a failure it manufactured.
//
// Nothing is lost by excluding it. The mcp driver already records its own
// credential verdict where the evidence is real: the pool parks a failed
// handshake with the remote's own message and drops the oauth2 token on a
// mid-session 401, both on the path a tenant actually exercises. The sweep
// could only re-observe that at the cost of new outbound traffic.

import { and, eq, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { probeConnector } from "../connectors/drivers/index.ts";
import { flagConnectorAuthFailure } from "../connectors/reauth.ts";
import type { AuthType, ConnectorView, DriverName } from "../connectors/types.ts";
import type { RefreshOAuthJob } from "../credentials/oauth2/refresh-worker.ts";
import type { Db } from "../db/client.ts";
import { connectors, credentials } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";

// Consecutive scheduler-run auth failures on one workflow before the scan
// escalates to a `level:"error"` line. 3 = at least a full day of failures
// on a twice-daily schedule while still reacting within hours on `every:N`
// schedules.
const AUTH_FAILED_STREAK_THRESHOLD = 3;

/**
 * Execute one proactive connector re-auth scan for a single tenant.
 *
 * Selects all connectors for the tenant that:
 *   - are not soft-deleted
 *   - do not already need re-auth
 *   - have a non-open circuit (an open circuit means the endpoint is
 *     already known-broken; probing it again is unhelpful)
 *   - have an auth_type other than "none" (no credential to check on
 *     auth_type=none connectors)
 *   - are not driver `mcp` — probing one establishes a session and can park
 *     the server (see the module header)
 *
 * For each candidate, issues a driver-native probe via `probeConnector`
 * and flags the connector when the result carries `error_code` of
 * "credential_invalid" or "credential_expired". All other outcomes
 * (ok:true, network throws, credential_missing, scope_insufficient,
 * remote_*, unknown_upstream_error) are skipped.
 *
 * Each connector's probe is wrapped in its own try/catch so a driver bug
 * that throws does not abort the sweep for the rest.
 */
export async function runConnectorReauthScanForTenant(
  tenant_id: string,
  now: Date,
  db: Db,
): Promise<void> {
  // tenant-filter:bound — every query below is scoped to this tenant_id
  const candidates = await db
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        isNull(connectors.deleted_at),
        // A disabled connector is one an operator switched off. Probing it
        // would make a real outbound request on behalf of something the
        // tenant said not to use — and for the mcp driver that request is a
        // full handshake that can park the connector in backoff.
        eq(connectors.enabled, true),
        eq(connectors.needs_reauth, false),
        ne(connectors.circuit_state, "open"),
        ne(connectors.auth_type, "none"),
        // See the module header: an mcp probe is a session handshake that
        // clears the connector's backoff and parks it on failure. A health
        // sweep must not be the thing that takes a server down.
        ne(connectors.driver, "mcp"),
      ),
    );

  // Connectors the candidate filter above excludes BECAUSE they are already
  // known-broken (flagged needs_reauth, or circuit open from repeated runtime
  // failures). Counted separately so the completed summary can't read as
  // "everything healthy" while a flagged connector keeps 401-ing scheduled
  // workflows — that exact misread happened with `auth_failed: 0` alongside
  // 13 runtime 401s on a flagged connector.
  const [knownBroken] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        isNull(connectors.deleted_at),
        ne(connectors.auth_type, "none"),
        or(eq(connectors.needs_reauth, true), eq(connectors.circuit_state, "open")),
      ),
    );
  const known_auth_failed = knownBroken?.n ?? 0;

  // Connectors this sweep deliberately never asks about. Counted and
  // reported so `candidate_count: 0` alongside `probed: 0` cannot read as
  // "this tenant has nothing to check" when it has MCP remotes the sweep is
  // structurally blind to — the same misread `known_auth_failed` exists to
  // prevent.
  const [mcpExcluded] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        isNull(connectors.deleted_at),
        eq(connectors.driver, "mcp"),
        eq(connectors.enabled, true),
      ),
    );
  const mcp_not_probed = mcpExcluded?.n ?? 0;

  logger.info({
    module: "scheduler",
    action: "connector_reauth_scan.started",
    msg: "proactive connector re-auth scan started",
    tenant_id,
    candidate_count: candidates.length,
    known_auth_failed,
    mcp_not_probed,
  });

  let probed = 0;
  let auth_failed = 0;

  for (const row of candidates) {
    // Build a ConnectorView from the DB row so probeConnector receives the
    // full typed shape it expects. The `driver` column is stored as plain
    // text in the schema; cast to DriverName here.
    const connector: ConnectorView = {
      id: row.id,
      tenant_id: row.tenant_id,
      slug: row.slug,
      display_name: row.display_name,
      driver: row.driver as DriverName,
      environment: row.environment,
      auth_type: row.auth_type as AuthType,
      base_url: row.base_url,
      dsn: row.dsn,
      config: (row.config as Record<string, unknown>) ?? {},
      operator_quirks: (row.operator_quirks as Record<string, unknown>) ?? {},
      template_slug: row.template_slug,
      template_name: row.template_name,
      template_source: row.template_source,
      template_version: row.template_version,
      template_snapshot: row.template_snapshot as Record<string, unknown> | null,
      self_description: (row.self_description as ConnectorView["self_description"]) ?? {},
      created_at: row.created_at,
      updated_at: row.updated_at,
      enabled: row.enabled,
      last_error: row.last_error,
      circuit_state: row.circuit_state as "closed" | "open" | "half-open",
      circuit_opened_at: row.circuit_opened_at,
      circuit_failure_count: row.circuit_failure_count,
      circuit_threshold: row.circuit_threshold,
      circuit_reset_ms: row.circuit_reset_ms,
      needs_reauth: row.needs_reauth,
      auth_failed_at: row.auth_failed_at,
      auth_failed_reason: row.auth_failed_reason,
      health_state: row.health_state ?? "ok",
      health_reason: row.health_reason ?? null,
      health_error_code: row.health_error_code ?? null,
      sunset_at: row.sunset_at ?? null,
      successor_uri: row.successor_uri ?? null,
    };

    let result: Awaited<ReturnType<typeof probeConnector>>;

    try {
      result = await probeConnector({ db, tenant_id, connector });
      probed += 1;
    } catch (err) {
      // Driver threw unexpectedly (bug, not a credential verdict).
      // Log and continue; the connector is NOT flagged.
      logger.warn({
        module: "scheduler",
        action: "connector_reauth_scan.probe_error",
        msg: "probe threw — not flagging connector",
        tenant_id,
        connector_id: row.id,
        connector_slug: row.slug,
        ...errorFields(err),
      });
      continue;
    }

    // Only "credential_invalid" and "credential_expired" are definitive
    // proof that the stored credential is dead. Everything else is either
    // healthy, ambiguous, or infrastructure noise.
    if (
      result.ok === false &&
      (result.error_code === "credential_invalid" || result.error_code === "credential_expired")
    ) {
      auth_failed += 1;

      try {
        await flagConnectorAuthFailure(db, connector, {
          reason: `proactive probe: credential rejected (${result.error_code})`,
        });
      } catch (err) {
        logger.error({
          module: "scheduler",
          action: "connector_reauth_scan.flag_failed",
          msg: "failed to flag connector needs_reauth — will retry on next scan",
          tenant_id,
          connector_id: row.id,
          ...errorFields(err),
        });
      }
    }
  }

  // Second phase: runtime evidence. The probe loop above only covers
  // connectors the candidate filter admits — a connector already flagged
  // (or circuit-open) is skipped by design, so its ongoing 401s at runtime
  // never show up in this scan. Sweep the scheduled-execution history for
  // auth_failed streaks so a schedule-bound workflow that keeps dying on a
  // dead credential produces a recurring error-level line.
  const streaks = await scanScheduledWorkflowAuthFailureStreaks(tenant_id, db);

  const duration_ms = Date.now() - now.getTime();
  logger.info({
    module: "scheduler",
    action: "connector_reauth_scan.completed",
    msg: "proactive connector re-auth scan completed",
    tenant_id,
    probed,
    auth_failed,
    known_auth_failed,
    mcp_not_probed,
    workflow_auth_failure_streaks: streaks,
    duration_ms,
  });
}

// How long an oauth2 credential may sit unexercised before the keep-alive
// sweep enqueues a proactive refresh. 3 days is well under every IdP
// idle-expiry window that keep-alive can actually help with (Google prod
// ~6 months unused, Microsoft ~90-day inactivity, Auth0 idle lifetimes in
// days); Google testing-mode's 7-day limit is absolute, not idle-based —
// no sweep can save those. A successful refresh bumps
// `credentials.updated_at`, so each credential costs at most one IdP call
// per window even though the sweep itself runs hourly.
export const OAUTH2_KEEPALIVE_IDLE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Enqueue a proactive oauth2 refresh for every credential of this tenant
 * whose token has not been exercised for OAUTH2_KEEPALIVE_IDLE_MS.
 *
 * The lazy inline refresh (`refreshIfStale` in the HTTP driver) and the
 * hourly probe scan above already keep tokens fresh for any connector
 * that sees traffic or probes. This sweep is the backstop for the rest —
 * circuit-open connectors (excluded from probe candidates), probes that
 * bail before an HTTP request, multi-day engine downtime — so refresh
 * tokens don't die of IdP idle-expiry while nothing exercises them.
 *
 * Candidate selection is fully unencrypted: `oauth2_refresh_ciphertext
 * IS NOT NULL` is the exact proxy for "has a refresh token" (the
 * refresh_token and cognito grants always persist one; a
 * client_credentials_json re-mint never does), and
 * `credentials.updated_at` is bumped by `rotateOAuth2Tokens` on every
 * rotation, making it the "token last exercised" timestamp.
 *
 * Deliberately NO circuit_state filter: the IdP token endpoint is a
 * different host than the broken API endpoint, and keeping the token
 * alive during an API outage is precisely the point. Connectors already
 * flagged needs_reauth are excluded — their refresh token is known-dead
 * and only a human re-issue revives them.
 *
 * Work is enqueued onto the existing `connector.refresh-oauth` pg-boss
 * queue (retry config in queue/queues.ts) rather than refreshed inline,
 * keeping IdP round-trips out of the reconciler tick. IdP *rejections*
 * are not retried: `refreshIfStale` swallows them and flags the
 * connector; pg-boss retries only cover infra errors.
 */
export async function runOAuth2RefreshKeepAliveForTenant(
  tenant_id: string,
  now: Date,
  db: Db,
  boss: Pick<PgBoss, "send">,
): Promise<void> {
  // tenant-filter:bound — the candidate query is scoped to this tenant_id
  const cutoff = new Date(now.getTime() - OAUTH2_KEEPALIVE_IDLE_MS);
  const candidates = await db
    .select({ credential_id: credentials.id })
    .from(credentials)
    .innerJoin(connectors, eq(credentials.connector_id, connectors.id))
    .where(
      and(
        eq(credentials.tenant_id, tenant_id),
        eq(credentials.mode, "oauth2"),
        isNull(credentials.deleted_at),
        isNotNull(credentials.connector_id),
        isNotNull(credentials.oauth2_refresh_ciphertext),
        lt(credentials.updated_at, cutoff),
        isNull(connectors.deleted_at),
        eq(connectors.needs_reauth, false),
      ),
    );

  let enqueued = 0;
  for (const { credential_id } of candidates) {
    try {
      await boss.send("connector.refresh-oauth", {
        tenant_id,
        credential_id,
      } satisfies RefreshOAuthJob);
      enqueued += 1;
    } catch (err) {
      logger.error({
        module: "scheduler",
        action: "oauth2_keepalive.enqueue_failed",
        msg: "failed to enqueue keep-alive refresh — will retry on next sweep",
        tenant_id,
        credential_id,
        ...errorFields(err),
      });
    }
  }

  logger.info({
    module: "scheduler",
    action: "oauth2_keepalive.completed",
    msg: "oauth2 refresh keep-alive sweep completed",
    tenant_id,
    candidate_count: candidates.length,
    enqueued,
    duration_ms: Date.now() - now.getTime(),
  });
}

/**
 * Detect schedule-bound workflows whose last AUTH_FAILED_STREAK_THRESHOLD
 * scheduler-sourced runs ALL failed on an auth-rejected connector response
 * (execution_steps.error.health = 'auth_failed' — stamped by the request
 * dispatcher's health classifier on 401/403/Seraph responses).
 *
 * Emits one `level:"error"` line per streak, naming workflow + connector,
 * on EVERY scan while the condition persists — deliberately recurring, so
 * journald-priority alerting keeps firing until a human re-authenticates
 * the connector or pauses the schedule. Returns the streak count for the
 * completed-summary line.
 */
async function scanScheduledWorkflowAuthFailureStreaks(tenant_id: string, db: Db): Promise<number> {
  // tenant-filter:bound — every CTE below is scoped to this tenant_id.
  // `recent` ranks each workflow's terminal scheduler runs newest-first;
  // `auth_failed` keeps the ranked runs that died on an auth rejection
  // (one row per run via DISTINCT ON); the outer HAVING demands ALL of the
  // last N runs be present — i.e. the failures are consecutive. The
  // connector identity is read from the newest run's failing step meta.
  const rows = await db.execute<{
    workflow_id: string;
    workflow_slug: string;
    connector_id: string | null;
    connector_slug: string | null;
  }>(sql`
    WITH recent AS (
      SELECT e.id, e.workflow_id,
             row_number() OVER (PARTITION BY e.workflow_id ORDER BY e.started_at DESC) AS rn
        FROM executions e
       WHERE e.tenant_id = ${tenant_id}
         AND e.request_source = 'scheduler'
         AND e.workflow_id IS NOT NULL
         AND e.started_at IS NOT NULL
         AND e.status IN ('succeeded', 'failed', 'timed_out', 'aborted')
    ),
    auth_failed AS (
      SELECT DISTINCT ON (r.workflow_id, r.rn)
             r.workflow_id, r.rn,
             s.request_meta->'connector'->>'connector_id' AS connector_id,
             s.request_meta->'connector'->>'connector_slug' AS connector_slug
        FROM recent r
        JOIN execution_steps s
          ON s.execution_id = r.id AND s.tenant_id = ${tenant_id}
       WHERE r.rn <= ${AUTH_FAILED_STREAK_THRESHOLD}
         AND s.status = 'failed'
         AND s.error->>'health' = 'auth_failed'
    )
    SELECT a.workflow_id,
           w.slug AS workflow_slug,
           (array_agg(a.connector_id ORDER BY a.rn))[1] AS connector_id,
           (array_agg(a.connector_slug ORDER BY a.rn))[1] AS connector_slug
      FROM auth_failed a
      JOIN workflows w
        ON w.id = a.workflow_id AND w.tenant_id = ${tenant_id} AND w.deleted_at IS NULL
     WHERE EXISTS (SELECT 1 FROM workflows_schedules ws
                    WHERE ws.workflow_id = a.workflow_id
                      AND ws.tenant_id = ${tenant_id}
                      AND ws.paused = false)
     GROUP BY a.workflow_id, w.slug
    HAVING count(*) >= ${AUTH_FAILED_STREAK_THRESHOLD}
  `);

  for (const r of rows.rows) {
    logger.error({
      module: "scheduler",
      action: "connector_reauth_scan.workflow_auth_failed",
      msg: `schedule-bound workflow '${r.workflow_slug}' failed its last ${AUTH_FAILED_STREAK_THRESHOLD} scheduled runs on connector auth (401/403) — re-authenticate connector '${r.connector_slug ?? "unknown"}'`,
      tenant_id,
      workflow_id: r.workflow_id,
      workflow_slug: r.workflow_slug,
      connector_id: r.connector_id,
      connector_slug: r.connector_slug,
      consecutive_failures: AUTH_FAILED_STREAK_THRESHOLD,
    });
  }
  return rows.rows.length;
}
