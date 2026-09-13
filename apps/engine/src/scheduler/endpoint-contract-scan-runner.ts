// Per-tenant runner for the scheduler's proactive endpoint-contract scan.
//
// The reactive half of "find out early" flags a removed endpoint when a RUN
// hits the 410; this runner is the PROACTIVE half: on a cadence, probe the
// actual operations committed workflows reference and classify the response
// with the same `classifyConnectorHealth` + deprecation parsing the runtime
// uses — so a vendor's endpoint removal (or a 2xx that announces its own
// Sunset) surfaces in `sk doctor` / notifications BEFORE an unattended run
// returns "0 results". This is the scan that would have caught the Atlassian
// `/rest/api/3/search` removal weeks earlier.
//
// Peer of `connector-reauth-scan-runner.ts` (same reconciler CAS-stamp
// cadence pattern, own `tenants.last_endpoint_contract_scan_at` column).
// Deliberately NOT inside `self-healing/proactive-scanner.ts` — that module's
// contract is DB-only/no-network; this one talks to vendors.
//
// Probe safety rules:
//   - GET operations only (HEAD support is inconsistent across vendors;
//     non-idempotent methods must never be fired speculatively).
//   - STATIC paths only — a path containing `${...}` placeholders cannot be
//     probed meaningfully without inputs.
//   - Connectors already flagged (needs_reauth / needs_update / open
//     circuit) are skipped: re-probing a known-broken integration is noise.
//   - Hard per-tenant operation cap so a workflow-heavy tenant cannot turn
//     the scan into a vendor hammer.
//   - Probes route through `callConnector`, so every probe is audited as a
//     normal `connector.invoked` row and credentials/auth injection follow
//     the exact runtime path.

import { and, eq, isNotNull, isNull } from "drizzle-orm";

import {
  callConnector,
  flagConnectorAuthFailure,
  flagConnectorContractFailure,
  parseDeprecation,
  setWorkflowHealth,
} from "../connectors/index.ts";
import type { Db } from "../db/client.ts";
import { connectors, workflows, workflowVersions } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";

/** Upper bound on probed operations per tenant per sweep. */
const MAX_OPERATIONS_PER_TENANT = 25;
/** Per-probe timeout — a contract probe is a liveness check, not a fetch. */
const PROBE_TIMEOUT_MS = 10_000;

interface CommittedOperation {
  connector_id: string;
  path: string;
  /** Workflows (id+slug) whose current version references this operation. */
  workflows: Array<{ id: string; slug: string }>;
}

/** Minimal step shape we read out of persisted DAGs — tolerant of legacy
 *  variants; anything that doesn't match is skipped, never thrown on. */
function extractGetOperations(dag: unknown): Array<{ connector_id: string; path: string }> {
  const out: Array<{ connector_id: string; path: string }> = [];
  const steps = (dag as { steps?: unknown })?.steps;
  if (!Array.isArray(steps)) return out;
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const s = step as Record<string, unknown>;
    if (s.kind !== "request") continue;
    const method = typeof s.method === "string" ? s.method.toUpperCase() : "GET";
    if (method !== "GET") continue;
    if (typeof s.connector_id !== "string" || typeof s.path !== "string") continue;
    // Placeholdered paths need inputs; probing them literally would 404
    // against `${...}` text and poison the verdict.
    if (s.path.includes("${")) continue;
    out.push({ connector_id: s.connector_id, path: s.path });
  }
  return out;
}

/**
 * Execute one proactive endpoint-contract scan for a single tenant: collect
 * the distinct (connector, GET path) operations referenced by committed
 * workflows, probe each through the normal authed call path, and roll
 * 410/deprecation verdicts into connector + workflow health (edge-guarded —
 * one notification per transition, however often the scan re-confirms it).
 */
export async function runEndpointContractScanForTenant(
  tenant_id: string,
  now: Date,
  db: Db,
): Promise<void> {
  // tenant-filter:bound — every query below is scoped to this tenant_id
  const committed = await db
    .select({
      workflow_id: workflows.id,
      workflow_slug: workflows.slug,
      dag: workflowVersions.dag,
    })
    .from(workflows)
    .innerJoin(workflowVersions, eq(workflowVersions.id, workflows.current_version_id))
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        isNull(workflows.deleted_at),
        isNotNull(workflows.current_version_id),
      ),
    );

  // Dedupe operations across workflows, remembering which workflows
  // reference each so a bad verdict can flip THEIR health too.
  const ops = new Map<string, CommittedOperation>();
  for (const row of committed) {
    for (const op of extractGetOperations(row.dag)) {
      const key = `${op.connector_id} ${op.path}`;
      const existing = ops.get(key);
      if (existing) {
        existing.workflows.push({ id: row.workflow_id, slug: row.workflow_slug });
      } else {
        ops.set(key, {
          ...op,
          workflows: [{ id: row.workflow_id, slug: row.workflow_slug }],
        });
      }
    }
  }

  // Probe only operations on connectors that are currently believed
  // healthy — re-probing a flagged/open-circuit connector is noise.
  const healthyConnectors = await db
    .select({ id: connectors.id, slug: connectors.slug, auth_type: connectors.auth_type })
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        isNull(connectors.deleted_at),
        eq(connectors.needs_reauth, false),
        eq(connectors.circuit_state, "closed"),
        eq(connectors.health_state, "ok"),
      ),
    );
  const healthyById = new Map(healthyConnectors.map((c) => [c.id, c]));

  const probeable = [...ops.values()].filter((op) => healthyById.has(op.connector_id));
  const capped = probeable.slice(0, MAX_OPERATIONS_PER_TENANT);
  if (probeable.length > capped.length) {
    logger.info({
      module: "scheduler",
      action: "endpoint_contract_scan.capped",
      msg: "operation list capped — remaining ops probe on later sweeps",
      tenant_id,
      total_operations: probeable.length,
      probed_operations: capped.length,
    });
  }

  logger.info({
    module: "scheduler",
    action: "endpoint_contract_scan.started",
    msg: "proactive endpoint-contract scan started",
    tenant_id,
    workflow_count: committed.length,
    operation_count: capped.length,
  });

  let probed = 0;
  let flagged = 0;

  for (const op of capped) {
    const connectorRef = healthyById.get(op.connector_id);
    if (!connectorRef) continue;
    const connector = { id: connectorRef.id, tenant_id, slug: connectorRef.slug };

    let result: Awaited<ReturnType<typeof callConnector>>;
    try {
      result = await callConnector({
        db,
        tenant_id,
        actor_id: null,
        connector_id: op.connector_id,
        method: "GET",
        path: op.path,
        timeout_ms: PROBE_TIMEOUT_MS,
      });
      probed += 1;
    } catch (err) {
      // Network/driver throw — infrastructure noise, never a contract
      // verdict. Log and keep sweeping.
      logger.warn({
        module: "scheduler",
        action: "endpoint_contract_scan.probe_error",
        msg: "contract probe threw — not flagging",
        tenant_id,
        connector_id: op.connector_id,
        path: op.path,
        ...errorFields(err),
      });
      continue;
    }

    if (result.kind !== "ok") continue;

    try {
      if (result.health === "endpoint_gone" || result.health === "deprecated") {
        flagged += 1;
        const severity = result.health === "endpoint_gone" ? "removed" : "deprecated";
        const { transitioned } = await flagConnectorContractFailure(db, connector, {
          error_code: severity === "removed" ? "endpoint_removed" : "endpoint_deprecated",
          deprecation: parseDeprecation(result.headers),
          reason:
            severity === "removed"
              ? `proactive contract probe: GET ${op.path} returned 410 Gone (used by ${op.workflows.map((w) => w.slug).join(", ")})`
              : `proactive contract probe: vendor announced deprecation of GET ${op.path} (used by ${op.workflows.map((w) => w.slug).join(", ")})`,
          workflow_id: op.workflows[0]?.id ?? null,
        });
        if (transitioned) {
          for (const wf of op.workflows) {
            await setWorkflowHealth(
              db,
              { id: wf.id, tenant_id },
              {
                state: "needs_attention",
                reason: `connector ${connector.slug}: GET ${op.path} ${severity === "removed" ? "was removed by the vendor" : "is deprecated by the vendor"}`,
              },
            );
          }
        }
      } else if (result.health === "auth_failed") {
        // The reauth scan owns credentials, but a definitive rejection
        // observed here is the same evidence — flag it (dedup guard makes
        // a double-flag from both scans a no-op).
        flagged += 1;
        await flagConnectorAuthFailure(
          db,
          {
            id: connector.id,
            tenant_id,
            slug: connector.slug,
            auth_type: connectorRef.auth_type as import("../connectors/types.ts").AuthType,
          },
          { reason: `proactive contract probe: GET ${op.path} rejected authentication` },
        );
      }
      // not_found / rate_limited / degraded: request-level or transient —
      // never a contract verdict from a single probe.
    } catch (err) {
      logger.error({
        module: "scheduler",
        action: "endpoint_contract_scan.flag_failed",
        msg: "failed to roll probe verdict into health — will retry next sweep",
        tenant_id,
        connector_id: op.connector_id,
        ...errorFields(err),
      });
    }
  }

  logger.info({
    module: "scheduler",
    action: "endpoint_contract_scan.completed",
    msg: "proactive endpoint-contract scan completed",
    tenant_id,
    probed,
    flagged,
    duration_ms: Date.now() - now.getTime(),
  });
}
