import { sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db, Executor } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { logger } from "../logging/logger.ts";
import { invalidateTenantState } from "../operator/index.ts";
import {
  type ConnectorHealthChangedPayload,
  ConnectorHealthChangedPayloadSchema,
} from "../pubsub/types.ts";
import type { DeprecationSignal } from "./health.ts";

export type ConnectorHealthState = "ok" | "degraded" | "needs_update" | "needs_reauth";
type WorkflowHealthState = "ok" | "needs_attention" | "degraded";

const PRECEDENCE: Record<ConnectorHealthState, number> = {
  ok: 0,
  degraded: 1,
  needs_update: 2,
  needs_reauth: 3,
};

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

interface ConnectorHealthTransition {
  state: ConnectorHealthState;
  reason: string;
  error_code?: string | null;
  sunset_at?: Date | null;
  successor_uri?: string | null;
  workflow_id?: string | null;
}

export async function setConnectorHealth(
  db: Db,
  connector: { id: string; tenant_id: string; slug: string },
  next: ConnectorHealthTransition,
): Promise<{ transitioned: boolean }> {
  const result = await db.transaction(async (tx) => {
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
  if (result.transitioned) invalidateTenantState(connector.tenant_id);
  return result;
}

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
