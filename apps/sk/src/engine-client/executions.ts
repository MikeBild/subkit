// Execution surfaces of the engine client — the unified
// `POST /v1/executions` run entrypoint plus per-execution inspection,
// cost rollups, streaming, and reruns. Method group merged into
// `EngineClient` by `../engine-client.ts`.

import type { components } from "@cli-core/engine-api/openapi.d.ts";

import type { EngineClient } from "../engine-client.ts";

// Aliased from the generated OpenAPI surface so command surfaces have a
// single import site and the snake_case wire shape stays authoritative.
export type ExecutionCost = components["schemas"]["ExecutionCost"];

/** Discriminated union matching the engine's RunBodySchema for
 *  POST /v1/executions. Keep in sync with
 *  apps/engine/src/http/routes/executions.ts. */
export type RunExecutionBody =
  | {
      source: "saved";
      workflow_id: string;
      version_id?: string;
      input?: unknown;
      async?: boolean;
      /** Caller-chosen key that makes the trigger safe to repeat. */
      idempotency_key?: string;
      request_source?: "api" | "cli" | "mcp" | "webhook" | "tool-chain" | "scheduler" | "chat";
    }
  | {
      source: "draft";
      definition: Record<string, unknown>;
      name?: string;
      input?: unknown;
      request_source?: "api" | "cli" | "mcp" | "webhook" | "tool-chain" | "scheduler" | "chat";
    }
  | {
      source: "step";
      step: Record<string, unknown>;
      workflow_slug?: string;
      input?: unknown;
      scope?: Record<string, unknown>;
      timeout_ms?: number;
      request_source?: "api" | "cli" | "mcp" | "webhook" | "tool-chain" | "scheduler" | "chat";
    };

/** Response shape of POST /v1/executions. Kept in sync with the engine's
 *  ExecutionRunResponse OpenAPI schema. Fields beyond `execution_id` and
 *  `status` are absent for async (queued) runs. */
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
    "none" | "bearer" | "header" | "query" | "basic" | "oauth2_static" | "oauth2_refreshed";
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
  /** True when an earlier run already used the idempotency key: nothing new started. */
  idempotent_replay?: boolean;
}

export const executionsMethods = {
  // -------------------- Executions --------------------
  /** Run a saved workflow, a draft definition, or a single step via the
   *  unified `POST /v1/executions` surface. Mirrors the discriminated
   *  union accepted by the server. */
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
  ): Promise<{ items: Record<string, unknown>[]; total: number }> {
    return this.request("GET", "/v1/executions", undefined, query);
  },
  getExecution(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/executions/${encodeURIComponent(id)}`);
  },
  executionSteps(this: EngineClient, id: string): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", `/v1/executions/${encodeURIComponent(id)}/steps`);
  },
  /**
   * Per-execution cost rollup — LLM weighted tokens / cache-read %
   * / latency (with a per-flow breakdown) plus external-call cost.
   * Backed by `/v1/executions/{id}/cost`, joined from the
   * `llm_usage` + `external_call_metering` ledgers (now keyed by
   * `execution_id`). The return shape is the generated OpenAPI schema
   * so a wire-shape drift is a typecheck failure here, not a silent
   * render of `undefined`.
   */
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
    return this.request("POST", `/v1/executions/${encodeURIComponent(id)}/rerun`, body);
  },
};
