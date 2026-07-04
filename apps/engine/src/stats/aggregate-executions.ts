// Read-time aggregation for GET /v1/stats/executions.
//
// Pure SQL builder over the `executions` table. NO new persistence:
// every number is a `date_trunc()` + `percentile_cont` query computed
// at read time. Three rollups come back in one round-trip so callers
// never re-sum: per-bucket series, per-group totals, window totals.
//
// TENANT ISOLATION (the critical invariant): `tenant_id = $tenantId` is
// the FIRST predicate in every WHERE clause and is bound from the
// authenticated principal — never from a user-supplied filter. A
// caller-supplied `workflow_id` / `status` / `request_source` can only
// narrow within the tenant; it can never widen across tenants.

import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { BucketUnit } from "../http/routes/stats/bucket-window.ts";

export type ExecutionGroupDim = "workflow_id" | "status" | "request_source";

export interface ExecutionsStatsParams {
  tenantId: string;
  bucket: BucketUnit;
  from: Date;
  to: Date;
  /** IANA tz used for bucket-boundary computation. Default "UTC". */
  tz: string;
  workflowId?: string | undefined;
  status?: string[] | undefined;
  requestSource?: string[] | undefined;
  executionMode?: "dev" | "prod" | undefined;
  /** ≤2 dims. Empty → a single synthetic group keyed `{}`. */
  groupBy: ExecutionGroupDim[];
}

export interface DurationAgg {
  total: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface ExecutionsBucketRow {
  ts: string;
  executions: number;
  duration_ms: DurationAgg;
}

export interface ExecutionsGroup {
  key: Record<string, string>;
  buckets: ExecutionsBucketRow[];
  totals: { executions: number; duration_ms: DurationAgg };
}

export interface ExecutionsStatsResult {
  groups: ExecutionsGroup[];
  totals: {
    executions: { count: number; by_status: Record<string, number> };
    duration_ms: DurationAgg;
  };
}

/** Column expression for a group dimension. */
function dimColumn(dim: ExecutionGroupDim): SQL {
  switch (dim) {
    case "workflow_id":
      return sql`workflow_id::text`;
    case "status":
      return sql`status::text`;
    case "request_source":
      return sql`request_source`;
  }
}

/** Duration in ms = finished_at - started_at, expressed as a numeric. */
const DURATION_MS = sql`(extract(epoch from (finished_at - started_at)) * 1000)`;

function durationSelect(): SQL {
  // percentile_cont needs a numeric domain; coalesce so unfinished /
  // null-duration rows contribute 0 to count-bearing aggregates but are
  // excluded from percentiles (filtered below) to avoid skewing latency.
  return sql`
    coalesce(sum(${DURATION_MS}) filter (where finished_at is not null), 0)::float8 as dur_total,
    coalesce(avg(${DURATION_MS}) filter (where finished_at is not null), 0)::float8 as dur_avg,
    coalesce(percentile_cont(0.5) within group (order by ${DURATION_MS}) filter (where finished_at is not null), 0)::float8 as dur_p50,
    coalesce(percentile_cont(0.95) within group (order by ${DURATION_MS}) filter (where finished_at is not null), 0)::float8 as dur_p95,
    coalesce(percentile_cont(0.99) within group (order by ${DURATION_MS}) filter (where finished_at is not null), 0)::float8 as dur_p99,
    coalesce(max(${DURATION_MS}) filter (where finished_at is not null), 0)::float8 as dur_max
  `;
}

function readDuration(row: Record<string, unknown>): DurationAgg {
  const n = (k: string): number => Math.round(Number(row[k] ?? 0));
  return {
    total: n("dur_total"),
    avg: n("dur_avg"),
    p50: n("dur_p50"),
    p95: n("dur_p95"),
    p99: n("dur_p99"),
    max: n("dur_max"),
  };
}

function buildWhere(p: ExecutionsStatsParams): SQL {
  // tenant_id FIRST — see module header. started_at window next.
  const conds: SQL[] = [
    sql`tenant_id = ${p.tenantId}`,
    sql`started_at is not null`,
    sql`started_at >= ${p.from}`,
    sql`started_at < ${p.to}`,
  ];
  if (p.workflowId) conds.push(sql`workflow_id = ${p.workflowId}`);
  if (p.status && p.status.length > 0) {
    conds.push(sql`status::text in ${p.status}`);
  }
  if (p.requestSource && p.requestSource.length > 0) {
    conds.push(sql`request_source in ${p.requestSource}`);
  }
  if (p.executionMode) conds.push(sql`execution_mode = ${p.executionMode}`);
  return sql.join(conds, sql` and `);
}

/** `date_trunc(bucket, started_at at the requested tz)`. Both `bucket`
 *  and `tz` are bound parameters — no string interpolation. The SELECT
 *  aliases this `bucket_ts` and every GROUP BY references that alias (see
 *  `GROUP_BY_BUCKET`) so the expression text appears exactly once,
 *  sidestepping ERROR 42803 without duplicating placeholders. */
function bucketExpr(p: ExecutionsStatsParams): SQL {
  return sql`date_trunc(${p.bucket}, started_at at time zone ${p.tz})`;
}

/** GROUP BY reference to the bucket: the SELECT alias, never the
 *  parameterized expression (which would emit a second placeholder
 *  Postgres cannot match against the SELECT one). */
const GROUP_BY_BUCKET = sql`bucket_ts`;

export async function aggregateExecutions(
  db: Db,
  p: ExecutionsStatsParams,
): Promise<ExecutionsStatsResult> {
  const where = buildWhere(p);
  const bucket = bucketExpr(p);
  const dims = p.groupBy.slice(0, 2);

  // --- per-bucket × per-group series -------------------------------------
  const dimSelects =
    dims.length > 0
      ? sql.join(
          dims.map((d) => sql`${dimColumn(d)} as ${sql.raw(`dim_${d}`)}`),
          sql`, `,
        )
      : undefined;
  const groupCols = dims.map((d) => dimColumn(d));
  const groupByClause =
    groupCols.length > 0 ? sql.join([GROUP_BY_BUCKET, ...groupCols], sql`, `) : GROUP_BY_BUCKET;

  const bucketRows = (
    await db.execute(sql`
      select
        ${bucket} as bucket_ts,
        ${dimSelects ? sql`${dimSelects},` : sql``}
        count(*)::int as executions,
        ${durationSelect()}
      from executions
      where ${where}
      group by ${groupByClause}
      order by bucket_ts asc
    `)
  ).rows as Record<string, unknown>[];

  // --- group key helpers -------------------------------------------------
  const keyOf = (row: Record<string, unknown>): Record<string, string> => {
    const key: Record<string, string> = {};
    for (const d of dims) {
      const v = row[`dim_${d}`];
      key[d] = v == null ? "" : String(v);
    }
    return key;
  };
  const keyStr = (key: Record<string, string>): string =>
    dims.map((d) => `${d}=${key[d]}`).join("|");

  // --- per-group totals (one row per group) ------------------------------
  const groupTotalRows =
    dims.length > 0
      ? ((
          await db.execute(sql`
            select
              ${dimSelects},
              count(*)::int as executions,
              ${durationSelect()}
            from executions
            where ${where}
            group by ${sql.join(groupCols, sql`, `)}
          `)
        ).rows as Record<string, unknown>[])
      : [];

  // --- window totals + by_status -----------------------------------------
  const windowRow = ((
    await db.execute(sql`
      select
        count(*)::int as executions,
        ${durationSelect()}
      from executions
      where ${where}
    `)
  ).rows[0] ?? {}) as Record<string, unknown>;

  const byStatusRows = (
    await db.execute(sql`
      select status::text as status, count(*)::int as n
      from executions
      where ${where}
      group by status
    `)
  ).rows as Record<string, unknown>[];

  // --- assemble groups ---------------------------------------------------
  const groupMap = new Map<string, ExecutionsGroup>();
  const ensure = (key: Record<string, string>): ExecutionsGroup => {
    const ks = keyStr(key);
    let g = groupMap.get(ks);
    if (!g) {
      g = {
        key,
        buckets: [],
        totals: {
          executions: 0,
          duration_ms: { total: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 },
        },
      };
      groupMap.set(ks, g);
    }
    return g;
  };

  for (const row of bucketRows) {
    const g = ensure(keyOf(row));
    g.buckets.push({
      ts: new Date(row.bucket_ts as string).toISOString(),
      executions: Number(row.executions ?? 0),
      duration_ms: readDuration(row),
    });
  }

  if (dims.length > 0) {
    for (const row of groupTotalRows) {
      const g = ensure(keyOf(row));
      g.totals = {
        executions: Number(row.executions ?? 0),
        duration_ms: readDuration(row),
      };
    }
  } else {
    // Single synthetic group: its totals are the window totals.
    const g = ensure({});
    g.totals = {
      executions: Number(windowRow.executions ?? 0),
      duration_ms: readDuration(windowRow),
    };
  }

  const byStatus: Record<string, number> = {};
  for (const r of byStatusRows) byStatus[String(r.status)] = Number(r.n ?? 0);

  return {
    groups: [...groupMap.values()],
    totals: {
      executions: { count: Number(windowRow.executions ?? 0), by_status: byStatus },
      duration_ms: readDuration(windowRow),
    },
  };
}
