// The connector circuit breaker's persistence: every write to
// `connectors.circuit_state` / `circuit_failure_count` / `circuit_opened_at`
// lives here, so the three columns cannot be written out of step.
//
//   closed ──failures reach the threshold──▶ open      (recordCircuitFailure)
//   open ──reset window elapsed, probe let through──▶ half-open
//   half-open / partial count ──the remote answered──▶ closed
//   any ──a person re-authorised the connector──▶ closed  (resetCircuitBreaker)
//
// `circuit_opened_at` is a fact about an OPEN breaker — when it tripped. A
// closed breaker has none, so closing clears it; half-open keeps it, because
// that is still the trip the probe is testing.

import { and, eq, sql } from "drizzle-orm";
import type { Db, Executor } from "../db/client.ts";
import { connectors } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";

/**
 * Persist a circuit-breaker state write. Drizzle builders are lazy — a bare
 * `void db.update(...)` never dispatches SQL — so every circuit write must be
 * awaited (or `.catch()`-chained) to take effect. The returned promise never
 * rejects: the step result must not depend on circuit bookkeeping, and on the
 * failure path a DB error here must not mask the original request error.
 */
export async function persistCircuitState(
  db: Db,
  connector: { tenant_id: string; id: string },
  set: { circuit_state: "closed" | "half-open"; circuit_failure_count?: number },
): Promise<void> {
  try {
    await db
      .update(connectors)
      .set(set.circuit_state === "closed" ? { ...set, circuit_opened_at: null } : set)
      .where(and(eq(connectors.tenant_id, connector.tenant_id), eq(connectors.id, connector.id)));
    logger.info({
      module: "connectors",
      action: "connector.circuit.transition",
      tenant_id: connector.tenant_id,
      connector_id: connector.id,
      circuit_state: set.circuit_state,
    });
  } catch (err) {
    logger.warn({
      module: "connectors",
      action: "connector.circuit.update_failed",
      msg: "circuit-breaker state write failed",
      tenant_id: connector.tenant_id,
      connector_id: connector.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record a request failure against the connector's circuit breaker in ONE
 * atomic statement: the increment reads the column (not a stale snapshot, so
 * concurrent failures cannot lose updates) and the same UPDATE flips the
 * circuit open when the new count reaches the threshold. Logs exactly once on
 * the open transition. Never rejects (see persistCircuitState).
 */
export async function recordCircuitFailure(
  db: Db,
  connector: { tenant_id: string; id: string },
): Promise<void> {
  try {
    const rows = await db
      .update(connectors)
      .set({
        circuit_failure_count: sql`${connectors.circuit_failure_count} + 1`,
        circuit_opened_at: sql`CASE WHEN ${connectors.circuit_failure_count} + 1 >= ${connectors.circuit_threshold} AND ${connectors.circuit_state} <> 'open' THEN now() ELSE ${connectors.circuit_opened_at} END`,
        circuit_state: sql`CASE WHEN ${connectors.circuit_failure_count} + 1 >= ${connectors.circuit_threshold} THEN 'open' ELSE ${connectors.circuit_state} END`,
      })
      .where(and(eq(connectors.tenant_id, connector.tenant_id), eq(connectors.id, connector.id)))
      .returning({
        circuit_state: connectors.circuit_state,
        circuit_failure_count: connectors.circuit_failure_count,
        circuit_threshold: connectors.circuit_threshold,
      });
    const row = rows[0];
    if (row?.circuit_state === "open" && row.circuit_failure_count === row.circuit_threshold) {
      logger.warn({
        module: "connectors",
        action: "connector.circuit.opened",
        msg: "connector circuit breaker opened — requests blocked until reset",
        tenant_id: connector.tenant_id,
        connector_id: connector.id,
        circuit_failure_count: row.circuit_failure_count,
        circuit_threshold: row.circuit_threshold,
      });
    }
  } catch (err) {
    logger.warn({
      module: "connectors",
      action: "connector.circuit.update_failed",
      msg: "circuit-breaker failure write failed",
      tenant_id: connector.tenant_id,
      connector_id: connector.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Close the breaker and forget its failures, tenant-scoped. Unlike the
 * request path's best-effort writes this one rejects on a DB error: its
 * caller is a person's deliberate act, and an act that did not land must not
 * read as done.
 *
 * Returns the state it replaced when there was something to reset, and null
 * when the breaker was already closed and clean — so the caller audits the
 * edge and only the edge.
 */
export async function resetCircuitBreaker(
  db: Executor,
  tenant_id: string,
  connector_id: string,
): Promise<{ circuit_state: string; circuit_failure_count: number } | null> {
  const rows = await db.execute<{ prev_state: string; prev_count: number }>(sql`
    UPDATE connectors AS c
       SET circuit_state = 'closed',
           circuit_failure_count = 0,
           circuit_opened_at = NULL
      FROM (SELECT id, circuit_state AS prev_state, circuit_failure_count AS prev_count
              FROM connectors
             WHERE id = ${connector_id} AND tenant_id = ${tenant_id}
               AND (circuit_state <> 'closed'
                    OR circuit_failure_count <> 0
                    OR circuit_opened_at IS NOT NULL)
             FOR UPDATE) AS prev
     WHERE c.id = prev.id
    RETURNING prev.prev_state, prev.prev_count
  `);
  const prev = rows.rows[0];
  if (!prev) return null;
  logger.info({
    module: "connectors",
    action: "connector.circuit.transition",
    tenant_id,
    connector_id,
    circuit_state: "closed",
    from_state: prev.prev_state,
  });
  return { circuit_state: prev.prev_state, circuit_failure_count: Number(prev.prev_count) };
}
