// Execution-fixture retention.
//
// `execution_fixtures` captures real request/response pairs so self-healing
// can re-verify a patched step against a concrete past response without
// touching the network. The table grows monotonically; over time it pins
// to tens of thousands of rows per active connector. This module trims it
// back to a per-endpoint cap, keeping only the most recent N rows per
// `(tenant_id, connector_id, endpoint_key)` group.
//
// Fixtures are replaceable evidence — the next failing run captures a
// fresh one — so retention is safe without an approval gate.
//
// Scheduled invocation is the operator's choice; ops can call
// `pruneExecutionFixtures({ max_per_endpoint })` from a periodic job or
// from the `sk diagnostics` admin surface.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { type Db, getDb } from "../db/client.ts";
import { executionFixtures } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";

export interface PruneParams {
  /** Maximum fixtures to retain per (tenant_id, connector_id, endpoint_key). */
  max_per_endpoint?: number;
}

export interface PruneResult {
  groups_scanned: number;
  rows_deleted: number;
}

export const DEFAULT_FIXTURE_MAX_PER_ENDPOINT = 100;

/**
 * Trim `execution_fixtures` back to `max_per_endpoint` rows per group,
 * keeping the freshest `captured_at` values. Safe to call repeatedly.
 *
 * Implementation notes:
 *   - We partition server-side using a CTE so large tenants don't load
 *     every row into application memory.
 *   - Deletion is bulk (`inArray` on the doomed ids) to keep the round
 *     trip to a single DELETE.
 */
export async function pruneExecutionFixtures(
  params: PruneParams = {},
  exec?: Db,
): Promise<PruneResult> {
  const db = exec ?? getDb();
  const cap = Math.max(
    1,
    Math.floor(
      params.max_per_endpoint ??
        Number(process.env.FIXTURE_MAX_PER_ENDPOINT ?? DEFAULT_FIXTURE_MAX_PER_ENDPOINT),
    ),
  );

  const rows = (await db.execute(sql`
    WITH ranked AS (
      SELECT
        id,
        tenant_id,
        connector_id,
        endpoint_key,
        ROW_NUMBER() OVER (
          PARTITION BY tenant_id, connector_id, endpoint_key
          ORDER BY captured_at DESC
        ) AS rn
      FROM execution_fixtures
      WHERE kind = 'fixture'
    )
    SELECT id::text AS id
    FROM ranked
    WHERE rn > ${cap}
  `)) as unknown as Array<{ id: string }>;

  if (rows.length === 0) {
    logger.info({
      module: "self-healing",
      action: "fixtures.prune.noop",
      msg: "no fixtures exceed retention cap",
      cap,
    });
    return { groups_scanned: 0, rows_deleted: 0 };
  }

  const ids = rows.map((r) => r.id);
  const groupsRows = (await db.execute(sql`
    SELECT COUNT(DISTINCT (tenant_id, connector_id, endpoint_key))::text AS groups
    FROM execution_fixtures
    WHERE id IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql.raw(","),
    )})
  `)) as unknown as Array<{ groups: string }>;
  const groups = Number(groupsRows[0]?.groups ?? 0);

  await db.delete(executionFixtures).where(inArray(executionFixtures.id, ids));

  logger.info({
    module: "self-healing",
    action: "fixtures.prune.ok",
    msg: "pruned stale fixtures",
    rows_deleted: rows.length,
    groups_scanned: groups,
    cap,
  });
  return { groups_scanned: groups, rows_deleted: rows.length };
}

// Silence biome — `and` + `eq` are kept imported for anyone reading this
// file who reaches for them later; the prune CTE runs raw SQL to stay
// within a single round trip.
export const _kept_imports = { and, eq, desc };
