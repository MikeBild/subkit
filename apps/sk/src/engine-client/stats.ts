import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";
import type { ApiQuery } from "./http.ts";

export type StatsQualityResponse = components["schemas"]["StatsQualityResponse"];
export type StatsUsageResponse = components["schemas"]["StatsUsageResponse"];
export type StatsLlmCost = components["schemas"]["StatsLlmCost"];
export type OperatingFigures = components["schemas"]["OperatingFigures"];

export interface StatsQuery {
  [key: string]: string | number | boolean | undefined;
  bucket: string;
  from: string;
  to?: string;
  tz?: string;
  group_by?: string;
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
  cost?: StatsLlmCost;
}

export const statsMethods = {
  async statsExecutions(this: EngineClient, query: StatsQuery): Promise<StatsExecutionsResponse> {
    const { data } = await this.api.GET("/v1/stats/executions", {
      params: { query: query as ApiQuery<"/v1/stats/executions", "get"> },
    });
    return data as StatsExecutionsResponse;
  },
  async statsConnectors(this: EngineClient, query: StatsQuery): Promise<StatsAuditResponse> {
    const { data } = await this.api.GET("/v1/stats/connectors", {
      params: { query: query as ApiQuery<"/v1/stats/connectors", "get"> },
    });
    return data as StatsAuditResponse;
  },
  async statsEvents(this: EngineClient, query: StatsQuery): Promise<StatsAuditResponse> {
    const { data } = await this.api.GET("/v1/stats/events", {
      params: { query: query as ApiQuery<"/v1/stats/events", "get"> },
    });
    return data as StatsAuditResponse;
  },
  async statsLlm(this: EngineClient, query: StatsQuery): Promise<StatsLlmResponse> {
    const { data } = await this.api.GET("/v1/stats/llm", {
      params: { query: query as ApiQuery<"/v1/stats/llm", "get"> },
    });
    return data as StatsLlmResponse;
  },
  async statsOperatingFigures(
    this: EngineClient,
    query: { window?: "24h" | "7d" | "30d"; from?: string; to?: string },
  ): Promise<OperatingFigures> {
    const { data } = await this.api.GET("/v1/stats/operating-figures", {
      params: { query: query as ApiQuery<"/v1/stats/operating-figures", "get"> },
    });
    return data as OperatingFigures;
  },
  async statsHttp(this: EngineClient, query: StatsQuery): Promise<StatsUsageResponse> {
    const { data } = await this.api.GET("/v1/stats/http", {
      params: { query: query as ApiQuery<"/v1/stats/http", "get"> },
    });
    return data as StatsUsageResponse;
  },
  async statsChat(this: EngineClient, query: StatsQuery): Promise<StatsUsageResponse> {
    const { data } = await this.api.GET("/v1/stats/chat", {
      params: { query: query as ApiQuery<"/v1/stats/chat", "get"> },
    });
    return data as StatsUsageResponse;
  },
  async statsMcp(this: EngineClient, query: StatsQuery): Promise<StatsUsageResponse> {
    const { data } = await this.api.GET("/v1/stats/mcp", {
      params: { query: query as ApiQuery<"/v1/stats/mcp", "get"> },
    });
    return data as StatsUsageResponse;
  },
  async statsConversations(this: EngineClient, query: StatsQuery): Promise<StatsUsageResponse> {
    const { data } = await this.api.GET("/v1/stats/conversations", {
      params: { query: query as ApiQuery<"/v1/stats/conversations", "get"> },
    });
    return data as StatsUsageResponse;
  },
  async statsQuality(this: EngineClient, query: StatsQuery): Promise<StatsQualityResponse> {
    const { data } = await this.api.GET("/v1/stats/quality", {
      params: { query: query as ApiQuery<"/v1/stats/quality", "get"> },
    });
    return data as StatsQualityResponse;
  },
};
