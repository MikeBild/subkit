import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { InvokeEnvironment } from "@shared/invoke-snippet.ts";
import type { EngineClient } from "../engine-client.ts";
import type { ApiBody, ApiQuery } from "./http.ts";

type Schemas = components["schemas"];

export type ExecutionCost = Schemas["ExecutionCost"];
export type RunEnvironment = InvokeEnvironment;
export type RunExecutionBody = ApiBody<"/v1/executions", "post">;
export type ExecutionRunDraftDefinition = Schemas["ExecutionRunDraftDefinition"];
export type RunExecutionStepSummary = Schemas["ExecutionRunStepSummary"];
export type ConnectorResolutionSummary = Schemas["ConnectorResolutionSummary"];
export type RunExecutionResponse = Schemas["ExecutionRunResponse"];
export type ExecutionListQuery = ApiQuery<"/v1/executions", "get">;
export type ExecutionListItem = Schemas["ExecutionListItem"];
export type ExecutionDetail = Schemas["ExecutionDetail"];
export type ExecutionStep = Schemas["ExecutionStep"];
export type RerunExecutionBody = ApiBody<"/v1/executions/{id}/rerun", "post">;

export const executionsMethods = {
  runExecution(
    this: EngineClient,
    body: RunExecutionBody,
    opts: { environment?: RunEnvironment } = {},
  ): Promise<RunExecutionResponse> {
    return this.request<RunExecutionResponse>(
      "POST",
      "/v1/executions",
      body,
      undefined,
      undefined,
      opts.environment ? { "x-subkit-environment": opts.environment } : undefined,
    );
  },

  async listExecutions(
    this: EngineClient,
    query: ExecutionListQuery = {},
  ): Promise<Schemas["ExecutionListResponse"]> {
    const { data } = await this.api.GET("/v1/executions", { params: { query } });
    return data as Schemas["ExecutionListResponse"];
  },
  async getExecution(this: EngineClient, id: string): Promise<ExecutionDetail> {
    const { data } = await this.api.GET("/v1/executions/{id}", { params: { path: { id } } });
    return data as ExecutionDetail;
  },
  async executionSteps(
    this: EngineClient,
    id: string,
  ): Promise<Schemas["ExecutionStepListResponse"]> {
    const { data } = await this.api.GET("/v1/executions/{id}/steps", { params: { path: { id } } });
    return data as Schemas["ExecutionStepListResponse"];
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
    body: Omit<RerunExecutionBody, "request_source"> = {},
  ): Promise<RunExecutionResponse> {
    const { data } = await this.api.POST("/v1/executions/{id}/rerun", {
      params: { path: { id } },
      body: { ...body, request_source: "cli" },
    });
    return data as RunExecutionResponse;
  },
};
