import { and, isNull, type SQL, sql } from "drizzle-orm";
import { workflowExecutionAuthorities } from "../db/schema/index.ts";

const table = workflowExecutionAuthorities;
const CLOCK = sql`clock_timestamp()`;

function at(moment: Date | SQL | undefined): SQL {
  if (moment === undefined) return CLOCK;
  return moment instanceof Date ? sql`${moment.toISOString()}::timestamptz` : moment;
}

export function authorityNotExpired(moment?: Date | SQL): SQL {
  return sql`(${table.valid_until} IS NULL OR ${table.valid_until} > ${at(moment)})`;
}

function authorityHasRunsLeft(): SQL {
  return sql`(${table.max_runs} IS NULL OR ${table.reserved_runs} < ${table.max_runs})`;
}

export function authorityLive(moment?: Date | SQL): SQL {
  return and(
    isNull(table.revoked_at),
    sql`${table.valid_from} <= ${at(moment)}`,
    authorityNotExpired(moment),
    authorityHasRunsLeft(),
  ) as SQL;
}
