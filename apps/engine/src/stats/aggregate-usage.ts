import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { BucketUnit } from "../http/routes/stats/bucket-window.ts";
import type { TrafficClass, UsageSurface } from "./usage-events.ts";

export const USAGE_GROUP_DIMS = [
  "operation",
  "outcome",
  "request_source",
  "traffic_class",
  "platform",
  "response_mode",
] as const;
export type UsageGroupDim = (typeof USAGE_GROUP_DIMS)[number];

interface UsageStatsParams {
  tenantId: string;
  surface: UsageSurface;
  bucket: BucketUnit;
  from: Date;
  to: Date;
  tz: string;
  trafficClass: TrafficClass[];
  operation?: string[] | undefined;
  outcome?: string[] | undefined;
  requestSource?: string[] | undefined;
  platform?: string[] | undefined;
  responseMode?: string[] | undefined;
  groupBy: UsageGroupDim[];
}

interface UsageDuration {
  measured: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

interface UsageRollup {
  calls: number;
  unique_actors: number;
  unique_sessions: number;
  failures: number;
  duration_ms: UsageDuration;
  bytes: { request: number; response: number };
  streams: { completed: number; cancelled: number; errored: number };
}

interface UsageBucket extends UsageRollup {
  ts: string;
}

interface UsageStatsResult {
  groups: Array<{ key: Record<string, string>; buckets: UsageBucket[]; totals: UsageRollup }>;
  totals: UsageRollup & {
    by_outcome: Record<string, number>;
    success_ratio: { numerator: number; denominator: number; value: number | null };
    surface_details: {
      sessions_initialized: number;
      sessions_closed: number;
      capacity_rejections: number;
      active_sessions_peak: number;
      sync_responses: number;
      async_responses: number;
      task_started: number;
    };
  };
}

function dimColumn(dim: UsageGroupDim): SQL {
  switch (dim) {
    case "operation":
      return sql`operation`;
    case "outcome":
      return sql`outcome`;
    case "request_source":
      return sql`request_source`;
    case "traffic_class":
      return sql`traffic_class`;
    case "platform":
      return sql`coalesce(platform, '')`;
    case "response_mode":
      return sql`coalesce(response_mode, '')`;
  }
}

function whereClause(p: UsageStatsParams): SQL {
  const conditions: SQL[] = [
    sql`tenant_id = ${p.tenantId}`,
    sql`surface = ${p.surface}`,
    sql`created_at >= ${p.from}`,
    sql`created_at < ${p.to}`,
    sql`traffic_class in ${p.trafficClass}`,
  ];
  if (p.operation?.length) conditions.push(sql`operation in ${p.operation}`);
  if (p.outcome?.length) conditions.push(sql`outcome in ${p.outcome}`);
  if (p.requestSource?.length) conditions.push(sql`request_source in ${p.requestSource}`);
  if (p.platform?.length) conditions.push(sql`platform in ${p.platform}`);
  if (p.responseMode?.length) conditions.push(sql`response_mode in ${p.responseMode}`);
  return sql.join(conditions, sql` and `);
}

const FAILURE = sql`outcome in ('client_error','server_error','denied','cancelled','disconnected','rate_limited','capacity_rejected')`;

function rollupSelect(): SQL {
  return sql`
    count(*)::int as calls,
    count(distinct actor_hmac)::int as unique_actors,
    count(distinct session_hmac)::int as unique_sessions,
    count(*) filter (where ${FAILURE})::int as failures,
    count(duration_ms)::int as duration_measured,
    coalesce(avg(duration_ms), 0)::float8 as duration_avg,
    coalesce(percentile_cont(0.5) within group (order by duration_ms) filter (where duration_ms is not null), 0)::float8 as duration_p50,
    coalesce(percentile_cont(0.95) within group (order by duration_ms) filter (where duration_ms is not null), 0)::float8 as duration_p95,
    coalesce(percentile_cont(0.99) within group (order by duration_ms) filter (where duration_ms is not null), 0)::float8 as duration_p99,
    coalesce(max(duration_ms), 0)::int as duration_max,
    coalesce(sum(request_bytes), 0)::float8 as request_bytes,
    coalesce(sum(response_bytes), 0)::float8 as response_bytes,
    count(*) filter (where stream_outcome = 'completed')::int as stream_completed,
    count(*) filter (where stream_outcome = 'cancelled')::int as stream_cancelled,
    count(*) filter (where stream_outcome = 'errored')::int as stream_errored
  `;
}

function readRollup(row: Record<string, unknown>): UsageRollup {
  const n = (key: string): number => Math.round(Number(row[key] ?? 0));
  return {
    calls: n("calls"),
    unique_actors: n("unique_actors"),
    unique_sessions: n("unique_sessions"),
    failures: n("failures"),
    duration_ms: {
      measured: n("duration_measured"),
      avg: n("duration_avg"),
      p50: n("duration_p50"),
      p95: n("duration_p95"),
      p99: n("duration_p99"),
      max: n("duration_max"),
    },
    bytes: { request: n("request_bytes"), response: n("response_bytes") },
    streams: {
      completed: n("stream_completed"),
      cancelled: n("stream_cancelled"),
      errored: n("stream_errored"),
    },
  };
}

function keyOf(row: Record<string, unknown>, dims: UsageGroupDim[]): Record<string, string> {
  const key: Record<string, string> = {};
  for (const dim of dims) key[dim] = String(row[`dim_${dim}`] ?? "");
  return key;
}

function keyString(key: Record<string, string>, dims: UsageGroupDim[]): string {
  return dims.map((dim) => `${dim}=${key[dim]}`).join("|");
}

export async function aggregateUsage(db: Db, p: UsageStatsParams): Promise<UsageStatsResult> {
  const where = whereClause(p);
  const dims = p.groupBy.slice(0, 2);
  const dimensionSelect =
    dims.length > 0
      ? sql.join(
          dims.map((dim) => sql`${dimColumn(dim)} as ${sql.raw(`dim_${dim}`)}`),
          sql`, `,
        )
      : undefined;
  const dimensionColumns = dims.map(dimColumn);
  const bucketRows = (
    await db.execute(sql`
      select
        date_trunc(${p.bucket}, created_at at time zone ${p.tz}) as bucket_ts,
        ${dimensionSelect ? sql`${dimensionSelect},` : sql``}
        ${rollupSelect()}
      from usage_events
      where ${where}
      group by ${sql.join([sql`bucket_ts`, ...dimensionColumns], sql`, `)}
      order by bucket_ts asc
    `)
  ).rows as Record<string, unknown>[];

  const groupRows =
    dims.length > 0
      ? ((
          await db.execute(sql`
            select ${dimensionSelect}, ${rollupSelect()}
            from usage_events
            where ${where}
            group by ${sql.join(dimensionColumns, sql`, `)}
          `)
        ).rows as Record<string, unknown>[])
      : [];

  const windowRow = ((
    await db.execute(sql`select ${rollupSelect()} from usage_events where ${where}`)
  ).rows[0] ?? {}) as Record<string, unknown>;
  const window = readRollup(windowRow);

  const byOutcomeRows = (
    await db.execute(sql`
      select outcome, count(*)::int as count
      from usage_events where ${where}
      group by outcome
    `)
  ).rows as Record<string, unknown>[];
  const detailsRow = ((
    await db.execute(sql`
      select
        count(*) filter (where operation = 'session/initialized')::int as sessions_initialized,
        count(*) filter (where operation = 'session/closed')::int as sessions_closed,
        count(*) filter (where outcome = 'capacity_rejected')::int as capacity_rejections,
        coalesce(max(active_sessions), 0)::int as active_sessions_peak,
        count(*) filter (where response_mode = 'sync')::int as sync_responses,
        count(*) filter (where response_mode = 'async')::int as async_responses,
        count(*) filter (where task_phase = 'working')::int as task_started
      from usage_events where ${where}
    `)
  ).rows[0] ?? {}) as Record<string, unknown>;

  const groups = new Map<
    string,
    { key: Record<string, string>; buckets: UsageBucket[]; totals: UsageRollup }
  >();
  const empty = (): UsageRollup => readRollup({});
  const ensure = (key: Record<string, string>) => {
    const id = keyString(key, dims);
    let group = groups.get(id);
    if (!group) {
      group = { key, buckets: [], totals: empty() };
      groups.set(id, group);
    }
    return group;
  };
  for (const row of bucketRows) {
    ensure(keyOf(row, dims)).buckets.push({
      ts: new Date(row.bucket_ts as string).toISOString(),
      ...readRollup(row),
    });
  }
  if (dims.length > 0) {
    for (const row of groupRows) ensure(keyOf(row, dims)).totals = readRollup(row);
  } else {
    ensure({}).totals = window;
  }

  const byOutcome = Object.fromEntries(
    byOutcomeRows.map((row) => [String(row.outcome), Number(row.count ?? 0)]),
  );
  const success = Number(byOutcome.success ?? 0);
  const num = (key: string) => Math.round(Number(detailsRow[key] ?? 0));
  return {
    groups: [...groups.values()],
    totals: {
      ...window,
      by_outcome: byOutcome,
      success_ratio: {
        numerator: success,
        denominator: window.calls,
        value: window.calls === 0 ? null : success / window.calls,
      },
      surface_details: {
        sessions_initialized: num("sessions_initialized"),
        sessions_closed: num("sessions_closed"),
        capacity_rejections: num("capacity_rejections"),
        active_sessions_peak: num("active_sessions_peak"),
        sync_responses: num("sync_responses"),
        async_responses: num("async_responses"),
        task_started: num("task_started"),
      },
    },
  };
}
