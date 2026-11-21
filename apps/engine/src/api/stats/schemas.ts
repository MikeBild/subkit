import { z } from "@hono/zod-openapi";
import { PRICE_SOURCES } from "../../llm/index.ts";
import { BUCKET_FILLS, BUCKET_UNITS } from "../../stats/index.ts";

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

const BucketWindowQuery = z.object({
  bucket: z.enum(BUCKET_UNITS),
  from: z.string().min(1),
  to: z.string().optional(),
  tz: z.string().optional(),
});

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

const FillParam = z
  .enum(BUCKET_FILLS)
  .optional()
  .describe(
    "zero (default): every bucket of the window is listed, empty ones with zeros. none: only buckets with data.",
  );

const EnvelopeBase = {
  bucket: z.enum(BUCKET_UNITS),
  tz: z.string(),
  from: z.string(),
  to: z.string(),
  truncated_at: z.string().optional(),
};

export const ExecutionsStatsQuery = BucketWindowQuery.extend({
  workflow_id: z.string().uuid().optional(),
  status: CsvOrArray,
  request_source: CsvOrArray,
  execution_mode: z.enum(["dev", "prod"]).optional(),
  group_by: CsvOrArray,
  fill: FillParam,
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

export const EventsStatsResponse = ConnectorsStatsResponse.openapi("StatsEventsResponse");

export const LlmStatsQuery = BucketWindowQuery.extend({
  model: CsvOrArray,
  flow: CsvOrArray,
  result: CsvOrArray.openapi({
    description:
      "Only calls with one of these results: success, quota_exhausted, context_too_large, error.",
  }),
  workflow_id: z.string().uuid().optional(),
  group_by: CsvOrArray,
  user_id: z.string().uuid().optional(),
  fill: FillParam,
}).openapi("StatsLlmQuery");

const LlmPartCost = z
  .object({
    amount: z.number(),
    currency: z.string(),
    unpriced_calls: z.number().int(),
    cache_savings: z.number(),
  })
  .openapi("StatsLlmPartCost");

const LlmBucket = z.object({
  ts: z.string(),
  calls: z.number(),
  tokens: TokenAggSchema,
  latency_ms: LatencyAggSchema,
  result: z.record(z.string(), z.number()),
  cost: LlmPartCost.optional(),
});

export const LlmStatsResponse = z
  .object({
    ...EnvelopeBase,
    groups: z.array(
      z.object({
        key: GroupKey,
        model_name: z.string().optional(),
        model_price: z
          .object({
            input_per_mtok: z.number(),
            output_per_mtok: z.number(),
            cache_read_per_mtok: z.number(),
            cache_write_per_mtok: z.number(),
            price_source: z.enum(PRICE_SOURCES),
            currency: z.string(),
          })
          .optional(),
        conversation: z
          .object({
            title: z.string().nullable(),
            owner_id: z.string().nullable(),
            updated_at: z.string(),
          })
          .optional(),
        buckets: z.array(LlmBucket),
        totals: z.object({
          calls: z.number(),
          tokens: TokenAggSchema,
          latency_ms: LatencyAggSchema,
          result: z.record(z.string(), z.number()),
        }),
        cost: LlmPartCost.optional(),
      }),
    ),
    totals: z.object({
      calls: z.object({ total: z.number(), by_result: z.record(z.string(), z.number()) }),
      tokens: TokenAggSchema,
      latency_ms: LatencyAggSchema,
    }),
    cost: z
      .object({
        amount: z.number(),
        currency: z.string(),
        unpriced_models: z.array(z.string()),
        unpriced_calls: z.number().int(),
        cache_savings: z.number(),
        price_sources: z.array(
          z.object({ model: z.string(), price_source: z.enum(PRICE_SOURCES) }),
        ),
        rates_basis: z.literal("current"),
      })
      .openapi("StatsLlmCost"),
  })
  .openapi("StatsLlmResponse");

export const StatsQualityQuery = BucketWindowQuery.extend({
  workflow_id: z.string().uuid().optional(),
}).openapi("StatsQualityQuery");

export const UsageStatsQuery = BucketWindowQuery.extend({
  traffic_class: CsvOrArray.default(["organic"]),
  operation: CsvOrArray,
  outcome: CsvOrArray,
  request_source: CsvOrArray,
  platform: CsvOrArray,
  response_mode: CsvOrArray,
  group_by: CsvOrArray,
}).openapi("StatsUsageQuery");

const UsageDurationSchema = z.object({
  measured: z.number(),
  avg: z.number(),
  p50: z.number(),
  p95: z.number(),
  p99: z.number(),
  max: z.number(),
});

const UsageRollupSchema = z.object({
  calls: z.number(),
  unique_actors: z.number(),
  unique_sessions: z.number(),
  failures: z.number(),
  duration_ms: UsageDurationSchema,
  bytes: z.object({ request: z.number(), response: z.number() }),
  streams: z.object({ completed: z.number(), cancelled: z.number(), errored: z.number() }),
});

const UsageTotalsSchema = UsageRollupSchema.extend({
  by_outcome: z.record(z.string(), z.number()),
  success_ratio: z.object({
    numerator: z.number(),
    denominator: z.number(),
    value: z.number().nullable(),
  }),
  surface_details: z.object({
    sessions_initialized: z.number(),
    sessions_closed: z.number(),
    capacity_rejections: z.number(),
    active_sessions_peak: z.number(),
    sync_responses: z.number(),
    async_responses: z.number(),
    task_started: z.number(),
  }),
});

export const UsageStatsResponse = z
  .object({
    schema_version: z.literal("subkit.usage-stats.v1"),
    surface: z.enum(["http", "chat", "mcp", "conversations"]),
    ...EnvelopeBase,
    traffic_class: z.array(z.enum(["organic", "synthetic", "internal"])),
    groups: z.array(
      z.object({
        key: GroupKey,
        buckets: z.array(UsageRollupSchema.extend({ ts: z.string() })),
        totals: UsageRollupSchema,
      }),
    ),
    totals: UsageTotalsSchema,
    semantic: z.object({
      value_state: z.enum(["measured", "zero", "missing"]),
      value_kind: z.literal("count"),
      unit: z.literal("calls"),
    }),
    quality: z.object({
      sampled: z.literal(false),
      unique_scope: z.literal("exact_window"),
      identity: z.literal("product_local_hmac"),
      content_captured: z.literal(false),
      retention_days: z.number(),
      duration_coverage: z.object({ numerator: z.number(), denominator: z.number() }),
    }),
  })
  .openapi("StatsUsageResponse");

const QualityFailureReason = z
  .object({
    code: z.string(),
    count: z.number(),
  })
  .openapi("StatsQualityFailureReason");

export const StatsQualityResponse = z
  .object({
    ...EnvelopeBase,
    one_shot: z.object({
      succeeded: z.number(),
      failed: z.number(),
      total: z.number(),
      success_rate: z.number(),
    }),
    post_repair: z.object({
      successes: z.number(),
      failures: z.number(),
      success_rate: z.number(),
    }),
    failure_reasons: z.array(QualityFailureReason),
  })
  .openapi("StatsQualityResponse");
