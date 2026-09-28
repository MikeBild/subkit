// Runtime-stats surfaces of the engine client. Tenant-scoped,
// time-bucketed read-only aggregates gated by `stats:read` server-side.
// Method group merged into `EngineClient` by `../engine-client.ts`.

import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";

// Aliased from the generated OpenAPI surface (WS-2 routes) so command
// surfaces have a single import site and the snake_case wire shape
// stays authoritative.
export type StatsQualityResponse = components["schemas"]["StatsQualityResponse"];
export type StatsUsageResponse = components["schemas"]["StatsUsageResponse"];
/** Priced spend of a window: catalog or override rate per model, unpriced models named. */
export type StatsLlmCost = components["schemas"]["StatsLlmCost"];
/** The Übersicht's four operations figures over one window. */
export type OperatingFigures = components["schemas"]["OperatingFigures"];

// ---------- Stats wire types ----------
// Mirror apps/engine/src/http/routes/stats/schemas.ts. Kept structural
// (not Zod) so the CLI tsc graph doesn't pull in @hono/zod-openapi.

export interface StatsQuery {
  // Index signature so the query object is accepted by `request`'s
  // `Record<string, string | number | boolean | undefined>` param.
  [key: string]: string | number | boolean | undefined;
  bucket: string;
  from: string;
  to?: string;
  tz?: string;
  group_by?: string;
  // route-specific filters (comma-joined for multi-value):
  workflow_id?: string;
  status?: string;
  request_source?: string;
  execution_mode?: string;
  connector_id?: string;
  connector_slug?: string;
  driver?: string;
  method?: string;
  outcome?: string;
  status_class?: string;
  include_endpoint?: boolean;
  class?: string;
  model?: string;
  flow?: string;
  user_id?: string;
  traffic_class?: string;
  operation?: string;
  platform?: string;
  response_mode?: string;
}

export interface StatsDurationAgg {
  total: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}
export type StatsLatencyAgg = StatsDurationAgg;
export interface StatsTokenAgg {
  prompt: number;
  completion: number;
  cache_read: number;
  cache_creation: number;
  total: number;
}

interface StatsEnvelope {
  bucket: string;
  tz: string;
  from: string;
  to: string;
  truncated_at?: string;
}

export interface StatsExecutionsResponse extends StatsEnvelope {
  groups: Array<{
    key: Record<string, string>;
    buckets: Array<{ ts: string; executions: number; duration_ms: StatsDurationAgg }>;
    totals: { executions: number; duration_ms: StatsDurationAgg };
  }>;
  totals: {
    executions: { count: number; by_status: Record<string, number> };
    duration_ms: StatsDurationAgg;
  };
}

export interface StatsAuditResponse extends StatsEnvelope {
  groups: Array<{
    key: Record<string, string>;
    buckets: Array<{
      ts: string;
      calls: number;
      latency_ms: StatsLatencyAgg;
      outcomes: { success: number; denied: number; error: number };
    }>;
    totals: {
      calls: { total: number; by_outcome: { success: number; denied: number; error: number } };
      latency_ms: StatsLatencyAgg;
    };
  }>;
  totals: {
    calls: {
      total: number;
      by_outcome: { success: number; denied: number; error: number };
      by_status_class: Record<string, number>;
    };
    latency_ms: StatsLatencyAgg;
  };
  truncated_endpoints?: boolean;
}

export interface StatsLlmResponse extends StatsEnvelope {
  groups: Array<{
    key: Record<string, string>;
    buckets: Array<{
      ts: string;
      calls: number;
      tokens: StatsTokenAgg;
      latency_ms: StatsLatencyAgg;
      result: Record<string, number>;
    }>;
    totals: { calls: number; tokens: StatsTokenAgg; latency_ms: StatsLatencyAgg };
  }>;
  totals: {
    calls: { total: number; by_result: Record<string, number> };
    tokens: StatsTokenAgg;
    latency_ms: StatsLatencyAgg;
  };
  /** Absent from an engine that predates priced usage. */
  cost?: StatsLlmCost;
}

export const statsMethods = {
  // --------------------------- Runtime stats ---------------------------
  // Tenant-scoped, time-bucketed read-only aggregates. Gated by the
  // `stats:read` permission server-side. Multi-value filters are passed
  // as comma-joined strings; the engine's CsvOrArray schema splits them.
  // Wire shape stays snake_case to match the OpenAPI surface.
  statsExecutions(this: EngineClient, query: StatsQuery): Promise<StatsExecutionsResponse> {
    return this.request("GET", "/v1/stats/executions", undefined, query);
  },
  statsConnectors(this: EngineClient, query: StatsQuery): Promise<StatsAuditResponse> {
    return this.request("GET", "/v1/stats/connectors", undefined, query);
  },
  statsEvents(this: EngineClient, query: StatsQuery): Promise<StatsAuditResponse> {
    return this.request("GET", "/v1/stats/events", undefined, query);
  },
  statsLlm(this: EngineClient, query: StatsQuery): Promise<StatsLlmResponse> {
    return this.request("GET", "/v1/stats/llm", undefined, query);
  },
  /**
   * The Übersicht's operations figures — runs, success rate, healthy
   * connectors, applied repairs — over one window. Backed by
   * `/v1/stats/operating-figures`, the reader MCP `get_operating_figures` uses.
   */
  statsOperatingFigures(
    this: EngineClient,
    query: { window?: "24h" | "7d" | "30d"; from?: string; to?: string },
  ): Promise<OperatingFigures> {
    return this.request("GET", "/v1/stats/operating-figures", undefined, query);
  },
  statsHttp(this: EngineClient, query: StatsQuery): Promise<StatsUsageResponse> {
    return this.request("GET", "/v1/stats/http", undefined, query);
  },
  statsChat(this: EngineClient, query: StatsQuery): Promise<StatsUsageResponse> {
    return this.request("GET", "/v1/stats/chat", undefined, query);
  },
  statsMcp(this: EngineClient, query: StatsQuery): Promise<StatsUsageResponse> {
    return this.request("GET", "/v1/stats/mcp", undefined, query);
  },
  statsConversations(this: EngineClient, query: StatsQuery): Promise<StatsUsageResponse> {
    return this.request("GET", "/v1/stats/conversations", undefined, query);
  },
  /**
   * Authoring-quality rollup — one-shot vs. post-repair success rates
   * and the top failure reasons over the window. Backed by
   * `/v1/stats/quality`. Return shape is the generated OpenAPI schema.
   */
  statsQuality(this: EngineClient, query: StatsQuery): Promise<StatsQualityResponse> {
    return this.request("GET", "/v1/stats/quality", undefined, query);
  },
};
