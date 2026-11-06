import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { InvokeEnvironment } from "@shared/invoke-snippet.ts";
import type { EngineClient } from "../engine-client.ts";
import type { ApiBody, ApiQuery } from "./http.ts";

export type ExecutionCost = components["schemas"]["ExecutionCost"];

export type RunEnvironment = InvokeEnvironment;

export type RunExecutionBody =
  | {
      source: "saved";
      workflow_id: string;
      version_id?: string;
      input?: unknown;
      async?: boolean;
      idempotency_key?: string;
      request_source?: "api" | "cli";
    }
  | {
      source: "draft";
      definition: Record<string, unknown>;
      name?: string;
      input?: unknown;
      request_source?: "api" | "cli";
    }
  | {
      source: "step";
      step: Record<string, unknown>;
      workflow_slug?: string;
      input?: unknown;
      scope?: Record<string, unknown>;
      timeout_ms?: number;
      request_source?: "api" | "cli";
    };

export interface RunExecutionStepSummary {
  step_key: string;
  step_index: number;
  kind: string;
  status: string;
  duration_ms: number | null;
  retry_count: number;
  error: unknown;
  request_meta?: Record<string, unknown> | null;
}

export interface ConnectorResolutionSummary {
  step_key: string;
  connector_id: string;
  connector_slug: string;
  driver: string;
  requested_environment: "dev" | "prod";
  resolved_environment: "dev" | "prod";
  auth_method:
    | "none"
    | "bearer"
    | "header"
    | "query"
    | "basic"
    | "oauth2_static"
    | "oauth2_refreshed";
  base_url?: string | null;
}

export interface RunExecutionResponse {
  execution_id: string;
  status: string;
  output?: unknown;
  error?: unknown;
  steps?: RunExecutionStepSummary[];
  connector_resolutions?: ConnectorResolutionSummary[];
  warnings?: unknown[];
  idempotent_replay?: boolean;
  hold_writes?: boolean;
}

export const executionsMethods = {
  runExecution(
    this: EngineClient,
    body: RunExecutionBody,
    opts: { environment?: RunEnvironment } = {},
  ): Promise<RunExecutionResponse> {
    return this.request<RunExecutionResponse>(
      "POST",
      "/v1/executions",
      body as Record<string, unknown>,
      undefined,
      undefined,
      opts.environment ? { "x-subkit-environment": opts.environment } : undefined,
    );
  },

  async listExecutions(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[]; total: number; next_cursor: string | null }> {
    const { data } = await this.api.GET("/v1/executions", {
      params: { query: query as ApiQuery<"/v1/executions", "get"> },
    });
    return data as { items: Record<string, unknown>[]; total: number; next_cursor: string | null };
  },
  async getExecution(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    const { data } = await this.api.GET("/v1/executions/{id}", { params: { path: { id } } });
    return data as Record<string, unknown>;
  },
  async executionSteps(
    this: EngineClient,
    id: string,
  ): Promise<{ items: Record<string, unknown>[] }> {
    const { data } = await this.api.GET("/v1/executions/{id}/steps", { params: { path: { id } } });
    return data as { items: Record<string, unknown>[] };
  },
  async executionCost(this: EngineClient, id: string): Promise<ExecutionCost> {
    const { data } = await this.api.GET("/v1/executions/{id}/cost", { params: { path: { id } } });
    return data as ExecutionCost;
  },
  async abortExecution(this: EngineClient, id: string): Promise<void> {
    await this.api.POST("/v1/executions/{id}/cancel", { params: { path: { id } } });
  },
  streamExecution(this: EngineClient, id: string): Promise<Response> {
    return this.stream(`/v1/executions/${encodeURIComponent(id)}/stream`);
  },
  async rerunExecution(
    this: EngineClient,
    id: string,
    body: { input?: unknown; async?: boolean } = {},
  ): Promise<RunExecutionResponse> {
    const { data } = await this.api.POST("/v1/executions/{id}/rerun", {
      params: { path: { id } },
      body: {
        ...body,
        request_source: "cli",
      } as ApiBody<"/v1/executions/{id}/rerun", "post">,
    });
    return data as RunExecutionResponse;
  },
};
