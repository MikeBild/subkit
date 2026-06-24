// Zod request/response schemas for the /v1/stats/* surface. The OpenAPI
// document is generated from these — never hand-written.
//
// Every aggregation route returns three rollup levels in one response:
//   - per-bucket: `groups[].buckets[]` — time-series for sparklines.
//   - per-group:  `groups[].totals`    — "workflow X had 42 runs".
//   - window:     top-level `totals`   — the whole-window summary.

import { z } from "@hono/zod-openapi";
import { BUCKET_UNITS } from "./bucket-window.ts";

// A query param may arrive as a single string or a repeated array. This
// coercion accepts both and yields a `string[]`. Used for the multi-value
// filters (status[], request_source[], driver[], model[], …) and for
// `group_by`.
const CsvOrArray = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v == null) return undefined;
    const arr = Array.isArray(v) ? v : v.split(",");
    return arr.map((s) => s.trim()).filter((s) => s.length > 0);
  });

const BoolParam = z
  .union([z.literal("true"), z.literal("false"), z.boolean()])
  .optional()
  .transform((v) => v === true || v === "true");

/** Common bucket grammar shared by every route. Validation of caps +
 *  retention happens in `bucket-window.ts` at the handler layer; the
 *  Zod schema only constrains the bucket enum and requires `from`. */
export const BucketWindowQuery = z.object({
  bucket: z.enum(BUCKET_UNITS),
  from: z.string().min(1),
  to: z.string().optional(),
  tz: z.string().optional(),
});

// ---- shared aggregate sub-objects -----------------------------------------

const DurationAggSchema = z
  .object({
    total: z.number(),
    avg: z.number(),
    p50: z.number(),
    p95: z.number(),
    p99: z.number(),
    max: z.number(),
  })
  .openapi("StatsDurationAgg");

const LatencyAggSchema = z
  .object({
    total: z.number(),
    avg: z.number(),
    p50: z.number(),
    p95: z.number(),
    p99: z.number(),
    max: z.number(),
  })
  .openapi("StatsLatencyAgg");

const TokenAggSchema = z
  .object({
    prompt: z.number(),
    completion: z.number(),
    cache_read: z.number(),
    cache_creation: z.number(),
    total: z.number(),
  })
  .openapi("StatsTokenAgg");

const GroupKey = z.record(z.string(), z.string());

const EnvelopeBase = {
  bucket: z.enum(BUCKET_UNITS),
  tz: z.string(),
  from: z.string(),
  to: z.string(),
  /** Set when `from` was clamped to the tenant's audit-retention
   *  horizon (audit-backed routes only). */
  truncated_at: z.string().optional(),
};

// ---- executions -----------------------------------------------------------

export const ExecutionsStatsQuery = BucketWindowQuery.extend({
  workflow_id: z.string().uuid().optional(),
  status: CsvOrArray,
  request_source: CsvOrArray,
  execution_mode: z.enum(["dev", "prod"]).optional(),
  group_by: CsvOrArray,
}).openapi("StatsExecutionsQuery");

const ExecutionsBucket = z.object({
  ts: z.string(),
  executions: z.number(),
  duration_ms: DurationAggSchema,
});

export const ExecutionsStatsResponse = z
  .object({
    ...EnvelopeBase,
    groups: z.array(
      z.object({
        key: GroupKey,
        buckets: z.array(ExecutionsBucket),
        totals: z.object({ executions: z.number(), duration_ms: DurationAggSchema }),
      }),
    ),
    totals: z.object({
      executions: z.object({ count: z.number(), by_status: z.record(z.string(), z.number()) }),
      duration_ms: DurationAggSchema,
    }),
  })
  .openapi("StatsExecutionsResponse");

// ---- connectors -----------------------------------------------------------

const OutcomeMap = z.object({
  success: z.number(),
  denied: z.number(),
  error: z.number(),
});

export const ConnectorsStatsQuery = BucketWindowQuery.extend({
  connector_id: z.string().optional(),
  connector_slug: z.string().optional(),
  driver: CsvOrArray,
  method: CsvOrArray,
  outcome: CsvOrArray,
  status_class: CsvOrArray,
  group_by: CsvOrArray,
  include_endpoint: BoolParam,
}).openapi("StatsConnectorsQuery");

const ConnectorsBucket = z.object({
  ts: z.string(),
  calls: z.number(),
  latency_ms: LatencyAggSchema,
  outcomes: OutcomeMap,
});

export const ConnectorsStatsResponse = z
  .object({
    ...EnvelopeBase,
    groups: z.array(
      z.object({
        key: GroupKey,
        buckets: z.array(ConnectorsBucket),
        totals: z.object({
          calls: z.object({ total: z.number(), by_outcome: OutcomeMap }),
          latency_ms: LatencyAggSchema,
        }),
      }),
    ),
    totals: z.object({
      calls: z.object({
        total: z.number(),
        by_outcome: OutcomeMap,
        by_status_class: z.record(z.string(), z.number()),
      }),
      latency_ms: LatencyAggSchema,
    }),
    truncated_endpoints: z.boolean().optional(),
  })
  .openapi("StatsConnectorsResponse");

// ---- events ---------------------------------------------------------------

export const EVENT_CLASSES = [
  "webhook_outbound",
  "webhook_inbound",
  "chat",
  "notification",
  "schedule",
  "self_healing",
  "discovery",
  "execution_lifecycle",
  "policy",
  "external_write",
] as const;

export const EventsStatsQuery = BucketWindowQuery.extend({
  class: z.enum(EVENT_CLASSES),
  outcome: CsvOrArray,
  group_by: CsvOrArray,
}).openapi("StatsEventsQuery");

// Events reuse the connectors response shape (same audit aggregator) but
// with `action` as the natural group axis.
export const EventsStatsResponse = ConnectorsStatsResponse.openapi("StatsEventsResponse");

// ---- llm ------------------------------------------------------------------

export const LlmStatsQuery = BucketWindowQuery.extend({
  model: CsvOrArray,
  flow: CsvOrArray,
  group_by: CsvOrArray,
  // Narrow to one user. Reading another user (or `group_by=user`) requires
  // the `stats:read:all` permission; own-usage reads need only `stats:read`.
  user_id: z.string().uuid().optional(),
}).openapi("StatsLlmQuery");

const LlmBucket = z.object({
  ts: z.string(),
  calls: z.number(),
  tokens: TokenAggSchema,
  latency_ms: LatencyAggSchema,
  result: z.record(z.string(), z.number()),
});

export const LlmStatsResponse = z
  .object({
    ...EnvelopeBase,
    groups: z.array(
      z.object({
        key: GroupKey,
        buckets: z.array(LlmBucket),
        totals: z.object({
          calls: z.number(),
          tokens: TokenAggSchema,
          latency_ms: LatencyAggSchema,
        }),
      }),
    ),
    totals: z.object({
      calls: z.object({ total: z.number(), by_result: z.record(z.string(), z.number()) }),
      tokens: TokenAggSchema,
      latency_ms: LatencyAggSchema,
    }),
  })
  .openapi("StatsLlmResponse");
