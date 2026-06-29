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

import { and, eq, isNull, ne } from "drizzle-orm";
import { probeConnector } from "../connectors/drivers/index.ts";
import { flagConnectorAuthFailure } from "../connectors/reauth.ts";
import type { AuthType, ConnectorView, DriverName } from "../connectors/types.ts";
import type { Db } from "../db/client.ts";
import { connectors } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";

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
        eq(connectors.needs_reauth, false),
        ne(connectors.circuit_state, "open"),
        ne(connectors.auth_type, "none"),
      ),
    );

  logger.info({
    module: "scheduler",
    action: "connector_reauth_scan.started",
    msg: "proactive connector re-auth scan started",
    tenant_id,
    candidate_count: candidates.length,
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

  const duration_ms = Date.now() - now.getTime();
  logger.info({
    module: "scheduler",
    action: "connector_reauth_scan.completed",
    msg: "proactive connector re-auth scan completed",
    tenant_id,
    probed,
    auth_failed,
    duration_ms,
  });
}
