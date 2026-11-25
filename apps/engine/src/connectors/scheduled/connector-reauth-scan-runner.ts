import { and, eq, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { catalogMetadataView } from "../../api/catalog-metadata.ts";
import type { RefreshOAuthJob } from "../../credentials/oauth2/refresh-worker.ts";
import type { Db } from "../../db/client.ts";
import { withTenantScope } from "../../db/index.ts";
import { connectors, vaultItems } from "../../db/schema/index.ts";
import { errorFields, logger } from "../../logging/index.ts";
import { probeConnector } from "../drivers/index.ts";
import { flagConnectorAuthFailure } from "../reauth.ts";
import type { AuthType, ConnectorView, DriverName } from "../types.ts";

const AUTH_FAILED_STREAK_THRESHOLD = 3;

export async function runConnectorReauthScanForTenant(
  tenant_id: string,
  now: Date,
  db: Db,
): Promise<void> {
  const candidates = await db
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        isNull(connectors.deleted_at),
        eq(connectors.enabled, true),
        eq(connectors.needs_reauth, false),
        ne(connectors.circuit_state, "open"),
        ne(connectors.auth_type, "none"),
        ne(connectors.driver, "mcp"),
      ),
    );

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
    const connector: ConnectorView = {
      id: row.id,
      tenant_id: row.tenant_id,
      slug: row.slug,
      display_name: row.display_name,
      ...catalogMetadataView(row),
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

export const OAUTH2_KEEPALIVE_IDLE_MS = 3 * 24 * 60 * 60 * 1000;

export async function runOAuth2RefreshKeepAliveForTenant(
  tenant_id: string,
  now: Date,
  db: Db,
  boss: Pick<PgBoss, "send">,
): Promise<void> {
  const cutoff = new Date(now.getTime() - OAUTH2_KEEPALIVE_IDLE_MS);
  const candidates = await withTenantScope(db, tenant_id, (tx) =>
    tx
      .select({ credential_id: vaultItems.id })
      .from(vaultItems)
      .innerJoin(connectors, eq(vaultItems.connector_id, connectors.id))
      .where(
        and(
          eq(vaultItems.tenant_id, tenant_id),
          eq(vaultItems.mode, "oauth2"),
          isNull(vaultItems.deleted_at),
          isNotNull(vaultItems.connector_id),
          isNotNull(vaultItems.oauth2_refresh_ciphertext),
          lt(vaultItems.updated_at, cutoff),
          isNull(connectors.deleted_at),
          eq(connectors.needs_reauth, false),
        ),
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

async function scanScheduledWorkflowAuthFailureStreaks(tenant_id: string, db: Db): Promise<number> {
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
