// Per-tenant runner for the scheduler's proactive connector re-auth scan.
//
// Extracted out of `reconciler.ts` (same split as `proactive-drift-scan-runner.ts`)
// to keep that file under the 1000-LOC ceiling. The reconciler owns the
// cadence + CAS-stamp logic; this module owns the per-tenant sweep: select
// candidate connectors, perform a lightweight authenticated probe, classify
// the response, and atomically flag connectors whose credentials are rejected.
//
// Only `classifyConnectorHealth === "auth_failed"` sets the flag. Network
// errors (thrown before a status is received) are logged and swallowed — a
// transient DNS or TCP failure must not be misread as a credential rejection.

import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { executeConnectorHttpRequest } from "../connectors/drivers/http.ts";
import { classifyConnectorHealth } from "../connectors/health.ts";
import { flagConnectorAuthFailure } from "../connectors/reauth.ts";
import { getConnectorProbeEndpoint } from "../connectors/template-binding.ts";
import type { AuthType, ConnectorView, DriverName } from "../connectors/types.ts";
import type { Db } from "../db/client.ts";
import { connectors } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";

// Auth types whose credentials can expire / be revoked and therefore
// benefit from a proactive probe. "none" and "aws_sigv4" are excluded:
// "none" has no credential to check; aws_sigv4 signs each request with
// short-lived STS tokens that are self-healing through the SDK.
const PROBEABLE_AUTH_TYPES = ["oauth2", "bearer", "basic", "header", "query"] as const;

/**
 * Execute one proactive connector re-auth scan for a single tenant.
 *
 * Selects all connectors for the tenant that:
 *   - are not soft-deleted
 *   - do not already need re-auth
 *   - have a non-open circuit (an open circuit means the endpoint is
 *     already known-broken; probing it again is unhelpful)
 *   - use an auth type that can expire (oauth2/bearer/basic/header/query)
 *
 * For each candidate, issues a lightweight authenticated GET (or the
 * connector's configured `probe_endpoint`) via `executeConnectorHttpRequest`
 * and classifies the response with `classifyConnectorHealth`. On an
 * `auth_failed` verdict the connector is atomically flagged and an
 * operator notification is emitted — both inside the same transaction so
 * the state change and the outbox event are always consistent.
 *
 * Each connector's probe is wrapped in its own try/catch so a network
 * error on one connector does not abort the sweep for the rest.
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
        inArray(connectors.auth_type, [...PROBEABLE_AUTH_TYPES]),
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
    // Derive probe target from the connector's configured probe_endpoint,
    // falling back to GET /. Mirrors exactly the logic in probeHttpConnector.
    const rawProbe = getConnectorProbeEndpoint(row);
    const probeConfig =
      rawProbe &&
      typeof rawProbe === "object" &&
      "path" in rawProbe &&
      "expected_status" in rawProbe
        ? (rawProbe as { method?: string; path: string; expected_status: [number, number] })
        : null;
    const method = probeConfig?.method ?? "GET";
    // Empty path means probe the base_url directly.
    const pathOrUrl = probeConfig !== null && probeConfig.path !== "" ? probeConfig.path : "/";

    // Build a ConnectorView from the DB row so executeConnectorHttpRequest
    // receives the full typed shape it expects. The `driver` column is
    // stored as plain text in the schema; cast to DriverName here.
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
    };

    if (!connector.base_url) {
      // No base_url — nothing to probe; skip silently.
      continue;
    }

    let status: number;
    let headers: Record<string, string>;

    try {
      const res = await executeConnectorHttpRequest({
        db,
        tenant_id,
        connector,
        method,
        path_or_url: pathOrUrl,
        // 10 s is enough to distinguish auth failure from slow vendor.
        timeout_ms: 10_000,
      });
      status = res.status;
      // HttpExecutionResult.headers keys are already lowercase (the HTTP driver
      // normalizes them via Headers.forEach). Pass through directly — the contract
      // that classifyConnectorHealth expects lowercase keys is already satisfied.
      headers = res.headers;
      probed += 1;
    } catch (err) {
      // Network-level error (DNS, TCP, timeout) — not a credential verdict.
      // Log and continue; the connector is NOT flagged.
      logger.warn({
        module: "scheduler",
        action: "connector_reauth_scan.probe_network_error",
        msg: "probe threw a network error — not flagging connector",
        tenant_id,
        connector_id: row.id,
        connector_slug: row.slug,
        ...errorFields(err),
      });
      continue;
    }

    const health = classifyConnectorHealth(status, headers);

    if (health !== "auth_failed") {
      // ok / degraded / endpoint_gone — none of these are credential failures.
      continue;
    }

    auth_failed += 1;

    try {
      await flagConnectorAuthFailure(db, connector, {
        reason: "proactive probe: credential rejected",
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
