import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { BucketUnit } from "../http/routes/stats/bucket-window.ts";

export type AuditOutcome = "success" | "denied" | "error";

export type StatusClass =
  | "2xx"
  | "3xx"
  | "4xx_other"
  | "4xx_auth"
  | "4xx_rate_limited"
  | "5xx"
  | "network_error"
  | "no_status";

export type AuditGroupDim =
  | "connector_id"
  | "connector_slug"
  | "driver"
  | "outcome"
  | "status_class"
  | "method"
  | "action"
  | "endpoint_path_template";

export interface AuditStatsParams {
  tenantId: string;
  bucket: BucketUnit;
  from: Date;
  to: Date;
  tz: string;
  actions: string[];
  excludeActionDriver?: { action: string; driver: string } | undefined;
  connectorId?: string | undefined;
  connectorSlug?: string | undefined;
  driver?: string[] | undefined;
  method?: string[] | undefined;
  outcome?: AuditOutcome[] | undefined;
  statusClass?: StatusClass[] | undefined;
  groupBy: AuditGroupDim[];
  includeEndpoint?: boolean | undefined;
}

export interface LatencyAgg {
  total: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface AuditBucketRow {
  ts: string;
  calls: number;
  latency_ms: LatencyAgg;
  outcomes: Record<AuditOutcome, number>;
}

export interface AuditGroup {
  key: Record<string, string>;
  buckets: AuditBucketRow[];
  totals: {
    calls: { total: number; by_outcome: Record<AuditOutcome, number> };
    latency_ms: LatencyAgg;
  };
}

export interface AuditStatsResult {
  groups: AuditGroup[];
  totals: {
    calls: {
      total: number;
      by_outcome: Record<AuditOutcome, number>;
      by_status_class: Record<string, number>;
    };
    latency_ms: LatencyAgg;
  };
  truncated_endpoints?: boolean;
}

const MAX_ENDPOINT_TEMPLATES = 200;

const LATENCY = sql`coalesce(
  nullif(metadata->>'latency_ms', '')::float8,
  nullif(metadata->>'duration_ms', '')::float8
)`;
const HAS_LATENCY = sql`(metadata ? 'latency_ms' or metadata ? 'duration_ms')`;

const CONNECTOR_ID = sql`coalesce(metadata->>'connector_id', resource_id::text)`;
const DRIVER = sql`coalesce(
  metadata->>'driver',
  case when action = 'mcp_external_tool.invoked' then 'mcp' end
)`;
const METHOD = sql`coalesce(metadata->>'method', metadata->>'operation')`;
const STATUS_CODE = sql`coalesce(
  nullif(metadata->>'status_code', '')::int,
  nullif(metadata->>'status', '')::int
)`;

const ENDPOINT_TEMPLATE = sql`
  regexp_replace(
    regexp_replace(
      split_part(
        regexp_replace(coalesce(metadata->>'path', metadata->>'url', ''), '^https?://[^/]+', ''),
        '?',
        1
      ),
      '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
      ':id',
      'g'
    ),
    '/[0-9]+', '/:id', 'g'
  )
`;

const STATUS_CLASS_CASE = sql`
  case
    when ${STATUS_CODE} is null and result = 'error' then 'network_error'
    when ${STATUS_CODE} between 200 and 299 then '2xx'
    when ${STATUS_CODE} between 300 and 399 then '3xx'
    when ${STATUS_CODE} in (401, 403) then '4xx_auth'
    when ${STATUS_CODE} = 429 then '4xx_rate_limited'
    when ${STATUS_CODE} between 400 and 499 then '4xx_other'
    when ${STATUS_CODE} between 500 and 599 then '5xx'
    else 'no_status'
  end
`;

function dimColumn(dim: AuditGroupDim): SQL {
  switch (dim) {
    case "connector_id":
      return CONNECTOR_ID;
    case "connector_slug":
      return sql`(metadata->>'connector_slug')`;
    case "driver":
      return DRIVER;
    case "method":
      return METHOD;
    case "outcome":
      return sql`result`;
    case "status_class":
      return STATUS_CLASS_CASE;
    case "action":
      return sql`action`;
    case "endpoint_path_template":
      return ENDPOINT_TEMPLATE;
  }
}

function latencySelect(): SQL {
  return sql`
    coalesce(sum(${LATENCY}) filter (where ${HAS_LATENCY}), 0)::float8 as lat_total,
    coalesce(avg(${LATENCY}) filter (where ${HAS_LATENCY}), 0)::float8 as lat_avg,
    coalesce(percentile_cont(0.5) within group (order by ${LATENCY}) filter (where ${HAS_LATENCY}), 0)::float8 as lat_p50,
    coalesce(percentile_cont(0.95) within group (order by ${LATENCY}) filter (where ${HAS_LATENCY}), 0)::float8 as lat_p95,
    coalesce(percentile_cont(0.99) within group (order by ${LATENCY}) filter (where ${HAS_LATENCY}), 0)::float8 as lat_p99,
    coalesce(max(${LATENCY}) filter (where ${HAS_LATENCY}), 0)::float8 as lat_max
  `;
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

function zeroOutcomes(): Record<AuditOutcome, number> {
  return { success: 0, denied: 0, error: 0 };
}

const OUTCOME_SELECT = sql`
  count(*) filter (where result = 'success')::int as oc_success,
  count(*) filter (where result = 'denied')::int as oc_denied,
  count(*) filter (where result = 'error')::int as oc_error
`;

function readOutcomes(row: Record<string, unknown>): Record<AuditOutcome, number> {
  return {
    success: Number(row.oc_success ?? 0),
    denied: Number(row.oc_denied ?? 0),
    error: Number(row.oc_error ?? 0),
  };
}

function buildWhere(p: AuditStatsParams): SQL {
  const conds: SQL[] = [
    sql`tenant_id = ${p.tenantId}`,
    p.actions.length > 0 ? sql`action in ${p.actions}` : sql`false`,
    sql`ts >= ${p.from}`,
    sql`ts < ${p.to}`,
  ];
  if (p.excludeActionDriver) {
    conds.push(
      sql`not (action = ${p.excludeActionDriver.action} and coalesce(metadata->>'driver', '') = ${p.excludeActionDriver.driver})`,
    );
  }
  if (p.connectorId) conds.push(sql`${CONNECTOR_ID} = ${p.connectorId}`);
  if (p.connectorSlug) conds.push(sql`(metadata->>'connector_slug') = ${p.connectorSlug}`);
  if (p.driver && p.driver.length > 0) conds.push(sql`${DRIVER} in ${p.driver}`);
  if (p.method && p.method.length > 0) conds.push(sql`${METHOD} in ${p.method}`);
  if (p.outcome && p.outcome.length > 0) conds.push(sql`result in ${p.outcome}`);
  if (p.statusClass && p.statusClass.length > 0) {
    conds.push(sql`(${STATUS_CLASS_CASE}) in ${p.statusClass}`);
  }
  return sql.join(conds, sql` and `);
}

function bucketExpr(p: AuditStatsParams): SQL {
  return sql`date_trunc(${p.bucket}, ts at time zone ${p.tz})`;
}

const GROUP_BY_BUCKET = sql`bucket_ts`;

export async function aggregateAudit(db: Db, p: AuditStatsParams): Promise<AuditStatsResult> {
  const where = buildWhere(p);
  const bucket = bucketExpr(p);
  const dims: AuditGroupDim[] = p.groupBy.slice(0, 2);
  if (p.includeEndpoint && !dims.includes("endpoint_path_template")) {
    dims.push("endpoint_path_template");
    dims.splice(2);
  }

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
        ${OUTCOME_SELECT},
        ${latencySelect()}
      from audit_log
      where ${where}
      group by ${groupByClause}
      order by bucket_ts asc
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

  const groupTotalRows =
    dims.length > 0
      ? ((
          await db.execute(sql`
            select
              ${dimSelects},
              count(*)::int as calls,
              ${OUTCOME_SELECT},
              ${latencySelect()}
            from audit_log
            where ${where}
            group by ${sql.join(groupCols, sql`, `)}
          `)
        ).rows as Record<string, unknown>[])
      : [];

  const windowRow = ((
    await db.execute(sql`
      select
        count(*)::int as calls,
        ${OUTCOME_SELECT},
        ${latencySelect()}
      from audit_log
      where ${where}
    `)
  ).rows[0] ?? {}) as Record<string, unknown>;

  const byStatusClassRows = (
    await db.execute(sql`
      select (${STATUS_CLASS_CASE}) as status_class, count(*)::int as n
      from audit_log
      where ${where}
      group by 1
    `)
  ).rows as Record<string, unknown>[];

  const groupMap = new Map<string, AuditGroup>();
  const ensure = (key: Record<string, string>): AuditGroup => {
    const ks = keyStr(key);
    let g = groupMap.get(ks);
    if (!g) {
      g = {
        key,
        buckets: [],
        totals: {
          calls: { total: 0, by_outcome: zeroOutcomes() },
          latency_ms: { total: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 },
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
      calls: Number(row.calls ?? 0),
      latency_ms: readLatency(row),
      outcomes: readOutcomes(row),
    });
  }

  if (dims.length > 0) {
    for (const row of groupTotalRows) {
      const g = ensure(keyOf(row));
      g.totals = {
        calls: { total: Number(row.calls ?? 0), by_outcome: readOutcomes(row) },
        latency_ms: readLatency(row),
      };
    }
  } else {
    const g = ensure({});
    g.totals = {
      calls: { total: Number(windowRow.calls ?? 0), by_outcome: readOutcomes(windowRow) },
      latency_ms: readLatency(windowRow),
    };
  }

  const byStatusClass: Record<string, number> = {};
  for (const r of byStatusClassRows) byStatusClass[String(r.status_class)] = Number(r.n ?? 0);

  let truncated = false;
  let groups = [...groupMap.values()];
  if (dims.includes("endpoint_path_template") && groups.length > MAX_ENDPOINT_TEMPLATES) {
    groups = groups
      .sort((a, b) => b.totals.calls.total - a.totals.calls.total)
      .slice(0, MAX_ENDPOINT_TEMPLATES);
    truncated = true;
  }

  const result: AuditStatsResult = {
    groups,
    totals: {
      calls: {
        total: Number(windowRow.calls ?? 0),
        by_outcome: readOutcomes(windowRow),
        by_status_class: byStatusClass,
      },
      latency_ms: readLatency(windowRow),
    },
  };
  if (truncated) result.truncated_endpoints = true;
  return result;
}
