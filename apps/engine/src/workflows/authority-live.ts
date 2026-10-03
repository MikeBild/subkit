// When an approval admits a new run. One predicate for every reader, so the
// open-ended form — no end date (`valid_until` NULL) and no run limit
// (`max_runs` NULL) — is read the same way everywhere: as unlimited, never as
// "expired" or "exhausted". The reservation trigger in the database applies
// the same rule when a run is inserted.

import { and, isNull, type SQL, sql } from "drizzle-orm";
import { workflowExecutionAuthorities } from "../db/schema/index.ts";

const table = workflowExecutionAuthorities;
const CLOCK = sql`clock_timestamp()`;

function at(moment: Date | SQL | undefined): SQL {
  if (moment === undefined) return CLOCK;
  return moment instanceof Date ? sql`${moment.toISOString()}::timestamptz` : moment;
}

/** Not yet ended by date at `moment`. */
export function authorityNotExpired(moment?: Date | SQL): SQL {
  return sql`(${table.valid_until} IS NULL OR ${table.valid_until} > ${at(moment)})`;
}

/** Has a run left. */
export function authorityHasRunsLeft(): SQL {
  return sql`(${table.max_runs} IS NULL OR ${table.reserved_runs} < ${table.max_runs})`;
}

/** Live at `moment` (the database clock by default): not revoked or ended,
 *  started, not past its end date, with a run left. */
export function authorityLive(moment?: Date | SQL): SQL {
  return and(
    isNull(table.revoked_at),
    sql`${table.valid_from} <= ${at(moment)}`,
    authorityNotExpired(moment),
    authorityHasRunsLeft(),
  ) as SQL;
}

/** Whether a grant has neither an end date nor a run limit. */
export function isOpenEnded(row: { valid_until: Date | null; max_runs: number | null }): boolean {
  return row.valid_until === null && row.max_runs === null;
}

/** Runs left, or null when there is no run limit. */
export function remainingRuns(row: {
  max_runs: number | null;
  reserved_runs: number;
}): number | null {
  return row.max_runs === null ? null : Math.max(0, row.max_runs - row.reserved_runs);
}
