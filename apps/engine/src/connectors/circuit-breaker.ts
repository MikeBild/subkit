import { and, eq, sql } from "drizzle-orm";
import type { Db, Executor } from "../db/client.ts";
import { connectors } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";

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
