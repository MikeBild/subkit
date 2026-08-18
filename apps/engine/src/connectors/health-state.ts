// Rolled-up connector/workflow health state.
//
// `connectors.health_state` is the single presentation rollup for "is this
// integration usable, and if not why" — it subsumes the credential flag
// (`needs_reauth`), removed/deprecated endpoints (`needs_update`), and
// repeated vendor failures (`degraded`). Every detector (runtime step
// failures, deprecation headers on live responses, the proactive
// endpoint-contract scan, preflight) rolls its verdict up through this
// module; nothing else writes the columns.
//
// Discipline mirrors reauth.ts exactly:
//   - transitions are atomic edge-guarded SQL (`WHERE health_state <> next`),
//     so a dead endpoint hammered N times per minute produces ONE transition;
//   - the notification event and the audit row are written on the transition
//     edge only, in the SAME transaction as the state flip;
//   - recovery (back to ok) is a cheap idempotent no-op when already ok.
//
// State machine (per connector, tenant-scoped):
//   ok ──repeated 5xx/429──────────▶ degraded
//   ok ──Deprecation/Sunset header─▶ needs_update (endpoint_deprecated)
//   ok ──410 Gone──────────────────▶ needs_update (endpoint_removed)
//   ok ──credential rejected───────▶ needs_reauth (via reauth.ts, mirrored here)
//   any ──successful authed call───▶ ok            (degraded/needs_reauth only —
//     needs_update does NOT auto-clear: the dead endpoint is still dead until
//     the workflow/template stops referencing it)
//
// Precedence when multiple faults coexist: needs_reauth > needs_update >
// degraded > ok (the operator-action-required states win the display).

import { sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db, Executor } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { logger } from "../logging/logger.ts";
import {
  type ConnectorHealthChangedPayload,
  ConnectorHealthChangedPayloadSchema,
} from "../pubsub/types.ts";
import type { DeprecationSignal } from "./health.ts";

export type ConnectorHealthState = "ok" | "degraded" | "needs_update" | "needs_reauth";
export type WorkflowHealthState = "ok" | "needs_attention" | "degraded";

const PRECEDENCE: Record<ConnectorHealthState, number> = {
  ok: 0,
  degraded: 1,
  needs_update: 2,
  needs_reauth: 3,
};

/**
 * Read-side reconciliation: the connectors row carries three overlapping
 * state machines (`circuit_state`, `needs_reauth`, `health_state`). Displays
 * (doctor, list_connectors, tenant snapshot) must present ONE verdict — the
 * highest-precedence fault — so the three columns never disagree in front of
 * the operator.
 */
export function effectiveConnectorHealth(row: {
  health_state: string;
  needs_reauth: boolean;
  circuit_state: string;
}): ConnectorHealthState {
  const stored = (row.health_state as ConnectorHealthState) ?? "ok";
  let effective = PRECEDENCE[stored] !== undefined ? stored : "ok";
  if (row.needs_reauth && PRECEDENCE.needs_reauth > PRECEDENCE[effective]) {
    effective = "needs_reauth";
  }
  if (row.circuit_state === "open" && PRECEDENCE.degraded > PRECEDENCE[effective]) {
    effective = "degraded";
  }
  return effective;
}

export interface ConnectorHealthTransition {
  state: ConnectorHealthState;
  /** Human-readable reason shown in doctor/notifications. */
  reason: string;
  /** Stable machine code (endpoint_removed | endpoint_deprecated | ...). */
  error_code?: string | null;
  /** Vendor-announced removal date, when known (deprecated endpoints). */
  sunset_at?: Date | null;
  /** Vendor-announced replacement URI, when known. */
  successor_uri?: string | null;
  /** Workflow that surfaced the fault, for the notification payload. */
  workflow_id?: string | null;
}

/**
 * Atomic edge-guarded transition of `connectors.health_state`, tenant-scoped.
 * Returns `{ transitioned: true }` ONLY when the stored state actually
 * changed — the dedup guard that keeps one dead endpoint from producing a
 * notification storm. On the edge it writes the notification event and the
 * audit row in the same transaction.
 */
export async function setConnectorHealth(
  db: Db,
  connector: { id: string; tenant_id: string; slug: string },
  next: ConnectorHealthTransition,
): Promise<{ transitioned: boolean }> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ prev_state: string }>(sql`
      UPDATE connectors AS c
         SET health_state = ${next.state},
             health_reason = ${next.reason},
             health_error_code = ${next.error_code ?? null},
             health_changed_at = now(),
             sunset_at = ${next.sunset_at ?? null},
             successor_uri = ${next.successor_uri ?? null}
        FROM (SELECT id, health_state AS prev_state FROM connectors
               WHERE id = ${connector.id} AND tenant_id = ${connector.tenant_id}
                 AND health_state <> ${next.state}) AS prev
       WHERE c.id = prev.id
      RETURNING prev.prev_state
    `);
    const prev = rows.rows[0]?.prev_state;
    if (prev === undefined) return { transitioned: false };

    logger[next.state === "ok" ? "info" : "warn"]({
      module: "connectors",
      action: "connector.health.changed",
      msg: `connector health ${prev} → ${next.state}`,
      tenant_id: connector.tenant_id,
      connector_id: connector.id,
      from_state: prev,
      to_state: next.state,
      error_code: next.error_code ?? null,
      reason: next.reason,
    });

    // Notify only on degradation edges — recovery back to ok is logged +
    // audited but must not page the operator.
    if (next.state !== "ok") {
      await emitConnectorHealthChanged(tx, {
        tenant_id: connector.tenant_id,
        connector_id: connector.id,
        connector_slug: connector.slug,
        from_state: prev,
        to_state: next.state,
        error_code: next.error_code ?? null,
        reason: next.reason,
        sunset_at: next.sunset_at?.toISOString() ?? null,
        successor_uri: next.successor_uri ?? null,
        workflow_id: next.workflow_id ?? null,
      });
    }

    await auditAwait(
      {
        tenant_id: connector.tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.CONNECTOR_HEALTH_CHANGED,
        resource_type: "connector",
        resource_id: connector.id,
        result: "success",
        reason: next.reason,
        metadata: {
          from_state: prev,
          to_state: next.state,
          error_code: next.error_code ?? null,
          sunset_at: next.sunset_at?.toISOString() ?? null,
          successor_uri: next.successor_uri ?? null,
        },
      },
      tx,
    );
    return { transitioned: true };
  });
}

/**
 * Recovery path: a successful authed call proves transient faults healed.
 * Clears `degraded` (and a stale `needs_reauth` mirror) back to ok —
 * deliberately NOT `needs_update`: a removed/deprecated endpoint stays
 * broken no matter how many OTHER endpoints succeed; it clears only when
 * the referencing workflow/template migrates (or a probe of the successor
 * succeeds).
 */
export async function clearConnectorHealthOnSuccess(
  db: Db,
  connector: { id: string; tenant_id: string; slug: string },
): Promise<void> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id FROM connectors
     WHERE id = ${connector.id} AND tenant_id = ${connector.tenant_id}
       AND health_state IN ('degraded', 'needs_reauth')
  `);
  if (rows.rows.length === 0) return;
  await setConnectorHealth(db, connector, {
    state: "ok",
    reason: "successful call — transient fault recovered",
  });
}

/**
 * The single entry point for contract faults (removed/deprecated endpoint).
 * Used by the request dispatcher (410 / deprecation headers at runtime) and
 * the proactive endpoint-contract scan, so the transition+notify discipline
 * lives in one place — the analog of reauth.ts's flagConnectorAuthFailure.
 */
export async function flagConnectorContractFailure(
  db: Db,
  connector: { id: string; tenant_id: string; slug: string },
  opts: {
    error_code: "endpoint_removed" | "endpoint_deprecated";
    reason: string;
    deprecation?: DeprecationSignal | null;
    workflow_id?: string | null;
  },
): Promise<{ transitioned: boolean }> {
  const sunsetMs = opts.deprecation?.sunset ? Date.parse(opts.deprecation.sunset) : Number.NaN;
  return setConnectorHealth(db, connector, {
    state: "needs_update",
    reason: opts.reason,
    error_code: opts.error_code,
    sunset_at: Number.isFinite(sunsetMs) ? new Date(sunsetMs) : null,
    successor_uri: opts.deprecation?.successor_uri ?? null,
    workflow_id: opts.workflow_id ?? null,
  });
}

/**
 * Workflow-level rollup: flips `workflows.health_state` on the edge only.
 * Carries the same audit discipline; notification rides on the connector
 * event (one fault → one notification, not one per dependent workflow).
 */
export async function setWorkflowHealth(
  db: Db,
  workflow: { id: string; tenant_id: string },
  next: { state: WorkflowHealthState; reason: string },
): Promise<{ transitioned: boolean }> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ prev_state: string }>(sql`
      UPDATE workflows AS w
         SET health_state = ${next.state},
             health_reason = ${next.reason},
             health_changed_at = now()
        FROM (SELECT id, health_state AS prev_state FROM workflows
               WHERE id = ${workflow.id} AND tenant_id = ${workflow.tenant_id}
                 AND health_state <> ${next.state}) AS prev
       WHERE w.id = prev.id
      RETURNING prev.prev_state
    `);
    const prev = rows.rows[0]?.prev_state;
    if (prev === undefined) return { transitioned: false };
    logger[next.state === "ok" ? "info" : "warn"]({
      module: "workflows",
      action: "workflow.health.changed",
      msg: `workflow health ${prev} → ${next.state}`,
      tenant_id: workflow.tenant_id,
      workflow_id: workflow.id,
      from_state: prev,
      to_state: next.state,
      reason: next.reason,
    });
    await auditAwait(
      {
        tenant_id: workflow.tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.WORKFLOW_HEALTH_CHANGED,
        resource_type: "workflow",
        resource_id: workflow.id,
        result: "success",
        reason: next.reason,
        metadata: { from_state: prev, to_state: next.state },
      },
      tx,
    );
    return { transitioned: true };
  });
}

/**
 * Operator-facing `connector.health_changed` notification. Same channel
 * contract as emitConnectorAuthFailed (reauth.ts): `notification.emitted` is
 * the only channel wired into the fanout queue. The payload is parsed through
 * `ConnectorHealthChangedPayloadSchema` — the same schema the published event
 * catalog exposes — so the shape is enforced here rather than asserted.
 */
async function emitConnectorHealthChanged(
  tx: Executor,
  ev: {
    tenant_id: string;
    connector_id: string;
    connector_slug: string;
    from_state: string;
    to_state: ConnectorHealthState;
    error_code: string | null;
    reason: string;
    sunset_at: string | null;
    successor_uri: string | null;
    workflow_id: string | null;
  },
): Promise<void> {
  const payload: ConnectorHealthChangedPayload = {
    // A removed endpoint blocks workflows today → error; deprecated/degraded
    // are warnings. The catalog's `actionable` predicate splits on the same
    // `error_code`.
    severity: ev.error_code === "endpoint_removed" ? "error" : "warn",
    workflow_id: ev.workflow_id,
    connector_id: ev.connector_id,
    connector_slug: ev.connector_slug,
    from_state: ev.from_state,
    to_state: ev.to_state,
    error_code: ev.error_code,
    reason: ev.reason,
    sunset_at: ev.sunset_at,
    successor_uri: ev.successor_uri,
  };
  await writeEvent(tx, {
    tenant_id: ev.tenant_id,
    channel: "notification.emitted",
    type: "connector.health_changed",
    payload: ConnectorHealthChangedPayloadSchema.parse(payload),
  });
}
