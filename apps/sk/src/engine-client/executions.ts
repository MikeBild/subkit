import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";

export type ExecutionCost = components["schemas"]["ExecutionCost"];

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
}

export const executionsMethods = {
  runExecution(this: EngineClient, body: RunExecutionBody): Promise<RunExecutionResponse> {
    return this.request<RunExecutionResponse>(
      "POST",
      "/v1/executions",
      body as Record<string, unknown>,
    );
  },

  listExecutions(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[]; total: number; next_cursor: string | null }> {
    return this.request("GET", "/v1/executions", undefined, query);
  },
  getExecution(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/executions/${encodeURIComponent(id)}`);
  },
  executionSteps(this: EngineClient, id: string): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", `/v1/executions/${encodeURIComponent(id)}/steps`);
  },
  executionCost(this: EngineClient, id: string): Promise<ExecutionCost> {
    return this.request("GET", `/v1/executions/${encodeURIComponent(id)}/cost`);
  },
  abortExecution(this: EngineClient, id: string): Promise<void> {
    return this.request("POST", `/v1/executions/${encodeURIComponent(id)}/cancel`);
  },
  streamExecution(this: EngineClient, id: string): Promise<Response> {
    return this.stream(`/v1/executions/${encodeURIComponent(id)}/stream`);
  },
  rerunExecution(
    this: EngineClient,
    id: string,
    body: { input?: unknown; async?: boolean } = {},
  ): Promise<RunExecutionResponse> {
    return this.request("POST", `/v1/executions/${encodeURIComponent(id)}/rerun`, {
      ...body,
      request_source: "cli",
    });
  },
};
