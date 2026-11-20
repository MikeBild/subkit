import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";
import type { ApiBody, ApiQuery } from "./http.ts";

type Schemas = components["schemas"];

export type Task = Schemas["Task"];
export type TaskView = Schemas["TaskView"];
export type TaskLatestRun = Schemas["TaskLatestRun"];
export type TaskRun = Schemas["TaskRun"];
export type TaskGrant = NonNullable<Schemas["TaskGrant"]>;
export type TaskCreateBody = ApiBody<"/v1/tasks", "post">;
export type TaskUpdateBody = ApiBody<"/v1/tasks/{id}", "put">;
export type TaskUpdateResult = Schemas["TaskUpdateResponse"];
export type TaskResumeResult = Task & { run: TaskRun | null };
export type TaskList = { items: Task[]; total: number };
export type TaskRunList = { items: TaskRun[]; total: number };

export const tasksMethods = {
  async listTasks(this: EngineClient, query: ApiQuery<"/v1/tasks", "get"> = {}): Promise<TaskList> {
    const { data } = await this.api.GET("/v1/tasks", { params: { query } });
    return data as TaskList;
  },
  async getTask(this: EngineClient, id: string): Promise<TaskView> {
    const { data } = await this.api.GET("/v1/tasks/{id}", { params: { path: { id } } });
    return data as TaskView;
  },
  async createTask(this: EngineClient, body: TaskCreateBody): Promise<Task> {
    const { data } = await this.api.POST("/v1/tasks", { body });
    return data as Task;
  },
  async updateTask(
    this: EngineClient,
    id: string,
    body: TaskUpdateBody,
  ): Promise<TaskUpdateResult> {
    const { data } = await this.api.PUT("/v1/tasks/{id}", { params: { path: { id } }, body });
    return data as TaskUpdateResult;
  },
  async deleteTask(this: EngineClient, id: string): Promise<Schemas["TaskDeleteResponse"]> {
    const { data } = await this.api.DELETE("/v1/tasks/{id}", { params: { path: { id } } });
    return data as Schemas["TaskDeleteResponse"];
  },
  async pauseTask(this: EngineClient, id: string): Promise<Task> {
    const { data } = await this.api.POST("/v1/tasks/{id}/pause", { params: { path: { id } } });
    return data as Task;
  },
  async resumeTask(this: EngineClient, id: string): Promise<TaskResumeResult> {
    const { data } = await this.api.POST("/v1/tasks/{id}/resume", { params: { path: { id } } });
    return data as TaskResumeResult;
  },
  async startTaskRun(this: EngineClient, id: string): Promise<TaskRun> {
    const { data } = await this.api.POST("/v1/tasks/{id}/runs", { params: { path: { id } } });
    return data as TaskRun;
  },
  async listTaskRuns(
    this: EngineClient,
    id: string,
    query: ApiQuery<"/v1/tasks/{id}/runs", "get"> = {},
  ): Promise<TaskRunList> {
    const { data } = await this.api.GET("/v1/tasks/{id}/runs", {
      params: { path: { id }, query },
    });
    return data as TaskRunList;
  },
  async getTaskRun(this: EngineClient, id: string): Promise<TaskRun> {
    const { data } = await this.api.GET("/v1/task-runs/{id}", { params: { path: { id } } });
    return data as TaskRun;
  },
  async abortTaskRun(this: EngineClient, id: string): Promise<TaskRun> {
    const { data } = await this.api.POST("/v1/task-runs/{id}/abort", { params: { path: { id } } });
    return data as TaskRun;
  },
  async listTaskGrants(this: EngineClient, id: string): Promise<{ items: TaskGrant[] }> {
    const { data } = await this.api.GET("/v1/tasks/{id}/grants", { params: { path: { id } } });
    return data as { items: TaskGrant[] };
  },
};
