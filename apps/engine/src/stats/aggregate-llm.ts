// Read-time aggregation for GET /v1/stats/llm over `llm_usage`. NO new
// persistence — `date_trunc()` + token sums + latency percentiles at
// read time. Three rollups in one round-trip.
//
// `llm_usage.result` is a free-text column; the canonical values today
// are "success" / "failure" but we surface whatever the column holds in
// `by_result` so a future result value is not silently dropped.
//
// TENANT ISOLATION: `tenant_id = $tenantId` is the FIRST predicate.
// model/flow filters can only narrow within the tenant.

import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { BucketUnit } from "../http/routes/stats/bucket-window.ts";

export type LlmGroupDim = "model" | "flow" | "user" | "workflow";

export interface LlmStatsParams {
  tenantId: string;
  bucket: BucketUnit;
  from: Date;
  to: Date;
  tz: string;
  model?: string[] | undefined;
  flow?: string[] | undefined;
  /** Narrow to a single user's rows. Applied AFTER the tenant predicate. */
  userId?: string | null | undefined;
  groupBy: LlmGroupDim[];
}

export interface LatencyAgg {
  total: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface TokenAgg {
  prompt: number;
  completion: number;
  cache_read: number;
  cache_creation: number;
  total: number;
}

export interface LlmBucketRow {
  ts: string;
  calls: number;
  tokens: TokenAgg;
  latency_ms: LatencyAgg;
  result: Record<string, number>;
}

export interface LlmGroup {
  key: Record<string, string>;
  buckets: LlmBucketRow[];
  totals: { calls: number; tokens: TokenAgg; latency_ms: LatencyAgg };
}

export interface LlmStatsResult {
  groups: LlmGroup[];
  totals: {
    calls: { total: number; by_result: Record<string, number> };
    tokens: TokenAgg;
    latency_ms: LatencyAgg;
  };
}

const LATENCY = sql`llm_usage.latency_ms::float8`;

function dimColumn(dim: LlmGroupDim): SQL {
  if (dim === "model") return sql`llm_usage.model`;
  if (dim === "user") return sql`llm_usage.user_id`;
  // The id, not the name: a workflow can be renamed, and a report that
  // silently splits one workflow into two because somebody edited its title is
  // worse than one that makes the caller resolve an id.
  if (dim === "workflow") return sql`executions.workflow_id`;
  return sql`llm_usage.flow`;
}

function tokenSelect(): SQL {
  return sql`
    coalesce(sum(llm_usage.prompt_tokens), 0)::float8 as tok_prompt,
    coalesce(sum(llm_usage.completion_tokens), 0)::float8 as tok_completion,
    coalesce(sum(llm_usage.cache_read_tokens), 0)::float8 as tok_cache_read,
    coalesce(sum(llm_usage.cache_creation_tokens), 0)::float8 as tok_cache_creation,
    coalesce(sum(llm_usage.total_tokens), 0)::float8 as tok_total
  `;
}

function latencySelect(): SQL {
  return sql`
    coalesce(sum(${LATENCY}), 0)::float8 as lat_total,
    coalesce(avg(${LATENCY}), 0)::float8 as lat_avg,
    coalesce(percentile_cont(0.5) within group (order by ${LATENCY}), 0)::float8 as lat_p50,
    coalesce(percentile_cont(0.95) within group (order by ${LATENCY}), 0)::float8 as lat_p95,
    coalesce(percentile_cont(0.99) within group (order by ${LATENCY}), 0)::float8 as lat_p99,
    coalesce(max(${LATENCY}), 0)::float8 as lat_max
  `;
}

function readTokens(row: Record<string, unknown>): TokenAgg {
  const n = (k: string): number => Math.round(Number(row[k] ?? 0));
  return {
    prompt: n("tok_prompt"),
    completion: n("tok_completion"),
    cache_read: n("tok_cache_read"),
    cache_creation: n("tok_cache_creation"),
    total: n("tok_total"),
  };
}

function readLatency(row: Record<string, unknown>): LatencyAgg {
  const n = (k: string): number => Math.round(Number(row[k] ?? 0));
  return {
    total: n("lat_total"),
    avg: n("lat_avg"),
    p50: n("lat_p50"),
    p95: n("lat_p95"),
    p99: n("lat_p99"),
    max: n("lat_max"),
  };
}

function buildWhere(p: LlmStatsParams): SQL {
  // Every column is qualified because `workflow` grouping joins `executions`,
  // which carries its own `tenant_id` and `created_at`. An unqualified name
  // becomes ambiguous the moment that join appears, and Postgres reports it as
  // a syntax error rather than picking one — which is the good outcome, but
  // only if the qualification is here rather than remembered later.
  const conds: SQL[] = [
    sql`llm_usage.tenant_id = ${p.tenantId}`,
    sql`llm_usage.created_at >= ${p.from}`,
    sql`llm_usage.created_at < ${p.to}`,
  ];
  if (p.model && p.model.length > 0) conds.push(sql`llm_usage.model in ${p.model}`);
  if (p.flow && p.flow.length > 0) conds.push(sql`llm_usage.flow in ${p.flow}`);
  // Narrowing predicate ONLY — always within the tenant scope above.
  if (p.userId) conds.push(sql`llm_usage.user_id = ${p.userId}`);
  return sql.join(conds, sql` and `);
}

/**
 * The FROM clause, with `executions` joined in only when a workflow dimension
 * asks for it.
 *
 * WHY conditional: every other grouping answers from `llm_usage` alone, and
 * making them all pay for a join so one of them can work would be the wrong
 * trade on the hot path.
 *
 * WHY LEFT: a row without an execution is not an error — the conversational
 * flows have no workflow at all, and they must still be counted, under an
 * empty key rather than dropped.
 */
function fromClause(p: LlmStatsParams): SQL {
  return p.groupBy.includes("workflow")
    ? sql`llm_usage left join executions on executions.id = llm_usage.execution_id`
    : sql`llm_usage`;
}

/** See aggregate-executions.ts: bucket + tz are bound params; the SELECT
 *  alias `bucket_ts` is what GROUP BY references. */
function bucketExpr(p: LlmStatsParams): SQL {
  return sql`date_trunc(${p.bucket}, llm_usage.created_at at time zone ${p.tz})`;
}

const GROUP_BY_BUCKET = sql`bucket_ts`;

export async function aggregateLlm(db: Db, p: LlmStatsParams): Promise<LlmStatsResult> {
  const where = buildWhere(p);
  const bucket = bucketExpr(p);
  const dims = p.groupBy.slice(0, 2);

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
        count(*)::int as calls,
        ${tokenSelect()},
        ${latencySelect()}
      from ${fromClause(p)}
      where ${where}
      group by ${groupByClause}
      order by bucket_ts asc
    `)
  ).rows as Record<string, unknown>[];

  // by_result is its own grouped query (result is high-cardinality-safe:
  // canonical values are success/failure). Uses the same raw-literal bucket
  // expression as bucketExpr() so GROUP BY matches SELECT.
  const resultRows = (
    await db.execute(sql`
      select
        ${dimSelects ? sql`${dimSelects},` : sql``}
        ${bucket} as bucket_ts,
        result,
        count(*)::int as n
      from ${fromClause(p)}
      where ${where}
      group by ${groupByClause}, llm_usage.result
    `)
  ).rows as Record<string, unknown>[];

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
  const bucketKey = (key: Record<string, string>, ts: string): string => `${keyStr(key)}@@${ts}`;

  const groupTotalRows =
    dims.length > 0
      ? ((
          await db.execute(sql`
            select
              ${dimSelects},
              count(*)::int as calls,
              ${tokenSelect()},
              ${latencySelect()}
            from ${fromClause(p)}
            where ${where}
            group by ${sql.join(groupCols, sql`, `)}
          `)
        ).rows as Record<string, unknown>[])
      : [];

  const windowRow = ((
    await db.execute(sql`
      select
        count(*)::int as calls,
        ${tokenSelect()},
        ${latencySelect()}
      from ${fromClause(p)}
      where ${where}
    `)
  ).rows[0] ?? {}) as Record<string, unknown>;

  const byResultRows = (
    await db.execute(sql`
      select llm_usage.result, count(*)::int as n
      from ${fromClause(p)}
      where ${where}
      group by llm_usage.result
    `)
  ).rows as Record<string, unknown>[];

  // Index by_result per (group, bucket_ts).
  const resultByBucket = new Map<string, Record<string, number>>();
  for (const row of resultRows) {
    const ts = new Date(row.bucket_ts as string).toISOString();
    const bk = bucketKey(keyOf(row), ts);
    const bucketResults = resultByBucket.get(bk) ?? {};
    bucketResults[String(row.result)] = Number(row.n ?? 0);
    resultByBucket.set(bk, bucketResults);
  }

  const groupMap = new Map<string, LlmGroup>();
  const ensure = (key: Record<string, string>): LlmGroup => {
    const ks = keyStr(key);
    let g = groupMap.get(ks);
    if (!g) {
      g = {
        key,
        buckets: [],
        totals: {
          calls: 0,
          tokens: { prompt: 0, completion: 0, cache_read: 0, cache_creation: 0, total: 0 },
          latency_ms: { total: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 },
        },
      };
      groupMap.set(ks, g);
    }
    return g;
  };

  for (const row of bucketRows) {
    const key = keyOf(row);
    const g = ensure(key);
    const ts = new Date(row.bucket_ts as string).toISOString();
    g.buckets.push({
      ts,
      calls: Number(row.calls ?? 0),
      tokens: readTokens(row),
      latency_ms: readLatency(row),
      result: resultByBucket.get(bucketKey(key, ts)) ?? {},
    });
  }

  if (dims.length > 0) {
    for (const row of groupTotalRows) {
      const g = ensure(keyOf(row));
      g.totals = {
        calls: Number(row.calls ?? 0),
        tokens: readTokens(row),
        latency_ms: readLatency(row),
      };
    }
  } else {
    const g = ensure({});
    g.totals = {
      calls: Number(windowRow.calls ?? 0),
      tokens: readTokens(windowRow),
      latency_ms: readLatency(windowRow),
    };
  }

  const byResult: Record<string, number> = {};
  for (const r of byResultRows) byResult[String(r.result)] = Number(r.n ?? 0);

  return {
    groups: [...groupMap.values()],
    totals: {
      calls: { total: Number(windowRow.calls ?? 0), by_result: byResult },
      tokens: readTokens(windowRow),
      latency_ms: readLatency(windowRow),
    },
  };
}
