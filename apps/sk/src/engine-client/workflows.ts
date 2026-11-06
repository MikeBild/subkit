import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";
import type { ApiBody, ApiQuery } from "./http.ts";

type Schemas = components["schemas"];

export type ScheduleEntry = Schemas["ScheduleEntry"];
export type ScheduleUpsertResponse = Schemas["ScheduleUpsertResponse"];
export type ScheduleWriteResponse = Schemas["ScheduleWriteResponse"];
export type ScheduleCreateBody = Schemas["ScheduleCreateBody"];
export type ScheduleUpdateBody = Schemas["ScheduleUpdateBody"];
export type WorkflowVersionEntry = Schemas["WorkflowVersion"];
export type WorkflowInvocation = Schemas["WorkflowInvocation"];
export type WorkflowDetail = Schemas["WorkflowDetail"];
export type WorkflowSaveResponse = Schemas["WorkflowSaveResponse"];
export type WorkflowListQuery = ApiQuery<"/v1/workflows", "get">;
export type CreateWorkflowRequest = ApiBody<"/v1/workflows", "post">;
export type UpdateWorkflowBody = ApiBody<"/v1/workflows/{id}", "put">;
export type ValidateWorkflowBody = ApiBody<"/v1/workflows/validate", "post">;

const VERSION_PAGE_SIZE = 200;

export const workflowsMethods = {
  async listWorkflowVersions(
    this: EngineClient,
    workflowId: string,
  ): Promise<Schemas["WorkflowVersionListResponse"]> {
    const items: WorkflowVersionEntry[] = [];
    let total = 0;
    do {
      const { data } = await this.api.GET("/v1/workflows/{id}/history", {
        params: {
          path: { id: workflowId },
          query: { limit: VERSION_PAGE_SIZE, offset: items.length },
        },
      });
      const page = data as Schemas["WorkflowVersionListResponse"];
      total = page.total;
      if (page.items.length === 0) break;
      items.push(...page.items);
    } while (items.length < total);
    return { items, total };
  },
  async getWorkflowInvocation(this: EngineClient, workflowId: string): Promise<WorkflowInvocation> {
    const { data } = await this.api.GET("/v1/workflows/{id}/invocation", {
      params: { path: { id: workflowId } },
    });
    return data as WorkflowInvocation;
  },
  async restoreWorkflowVersion(
    this: EngineClient,
    workflowId: string,
    version: number,
  ): Promise<WorkflowDetail> {
    const { data } = await this.api.POST("/v1/workflows/{id}/restore/{version}", {
      params: { path: { id: workflowId, version: String(version) } },
    });
    return data as WorkflowDetail;
  },

  async listWorkflows(
    this: EngineClient,
    query: WorkflowListQuery = {},
  ): Promise<Schemas["WorkflowListResponse"]> {
    const { data } = await this.api.GET("/v1/workflows", { params: { query } });
    return data as Schemas["WorkflowListResponse"];
  },
  async getWorkflow(this: EngineClient, id: string): Promise<WorkflowDetail> {
    const { data } = await this.api.GET("/v1/workflows/{id}", { params: { path: { id } } });
    return data as WorkflowDetail;
  },
  async createWorkflow(
    this: EngineClient,
    body: CreateWorkflowRequest,
  ): Promise<WorkflowSaveResponse> {
    const { data } = await this.api.POST("/v1/workflows", { body });
    return data as WorkflowSaveResponse;
  },
  async updateWorkflow(
    this: EngineClient,
    id: string,
    body: UpdateWorkflowBody,
  ): Promise<WorkflowSaveResponse> {
    const { data } = await this.api.PUT("/v1/workflows/{id}", { params: { path: { id } }, body });
    return data as WorkflowSaveResponse;
  },
  async validateWorkflowDraft(
    this: EngineClient,
    body: ValidateWorkflowBody,
  ): Promise<Schemas["ValidateWorkflowResponse"]> {
    const { data } = await this.api.POST("/v1/workflows/validate", { body });
    return data as Schemas["ValidateWorkflowResponse"];
  },
  async deleteWorkflow(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/workflows/{id}", { params: { path: { id } } });
  },

  async listSchedules(
    this: EngineClient,
    query: ApiQuery<"/v1/schedules", "get"> = {},
  ): Promise<Schemas["ScheduleListResponse"]> {
    const { data } = await this.api.GET("/v1/schedules", { params: { query } });
    return data as Schemas["ScheduleListResponse"];
  },
  async createSchedule(
    this: EngineClient,
    body: ScheduleCreateBody,
  ): Promise<ScheduleUpsertResponse> {
    const { data } = await this.api.POST("/v1/schedules", { body });
    return data as ScheduleUpsertResponse;
  },
  async updateSchedule(
    this: EngineClient,
    id: string,
    patch: ScheduleUpdateBody,
  ): Promise<ScheduleWriteResponse> {
    const { data } = await this.api.PUT("/v1/schedules/{id}", {
      params: { path: { id } },
      body: patch,
    });
    return data as ScheduleWriteResponse;
  },
  async deleteSchedule(this: EngineClient, id: string): Promise<Schemas["ScheduleDeleteResponse"]> {
    const { data } = await this.api.DELETE("/v1/schedules/{id}", { params: { path: { id } } });
    return data as Schemas["ScheduleDeleteResponse"];
  },
};
