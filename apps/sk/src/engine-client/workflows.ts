// Workflow CRUD + version history + schedule surfaces of the engine
// client. Method group merged into `EngineClient` by
// `../engine-client.ts`.

import type { EngineClient } from "../engine-client.ts";

export interface ScheduleEntry {
  id: string;
  workflow_id: string;
  workflow_slug: string | null;
  workflow_name: string | null;
  cron: string;
  timezone: string;
  execution_mode: "dev" | "prod";
  paused: boolean;
  input: unknown;
  created_at: string;
}

export interface ScheduleUpsertResponse extends ScheduleEntry {
  upsert_status: "created" | "updated";
}

export const workflowsMethods = {
  // --------------------------- Workflow versions ---------------------------
  /** List committed versions of a workflow (newest first). */
  listWorkflowVersions(
    this: EngineClient,
    workflowId: string,
  ): Promise<{
    items: Array<{ id: string; version: number; note: string | null; created_at: string }>;
  }> {
    return this.request("GET", `/v1/workflows/${encodeURIComponent(workflowId)}/history`);
  },
  /** Restore a prior workflow version as a new current version. */
  restoreWorkflowVersion(
    this: EngineClient,
    workflowId: string,
    version: number,
  ): Promise<{ id: string; current_version_id: string; version: number }> {
    return this.request(
      "POST",
      `/v1/workflows/${encodeURIComponent(workflowId)}/restore/${version}`,
    );
  },

  // -------------------- Workflows --------------------
  listWorkflows(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{
    items: Record<string, unknown>[];
    total: number;
    categories?: { category: string; count: number }[];
  }> {
    return this.request("GET", "/v1/workflows", undefined, query);
  },
  getWorkflow(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/workflows/${encodeURIComponent(id)}`);
  },
  createWorkflow(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/workflows", body);
  },
  updateWorkflow(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PUT", `/v1/workflows/${encodeURIComponent(id)}`, body);
  },
  validateWorkflowDraft(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; errors?: Array<{ path: string; message: string }> }> {
    return this.request("POST", "/v1/workflows/validate", body);
  },
  deleteWorkflow(this: EngineClient, id: string): Promise<void> {
    return this.request("DELETE", `/v1/workflows/${encodeURIComponent(id)}`);
  },

  // -------------------- Schedules --------------------
  listSchedules(
    this: EngineClient,
    query: { workflow_id?: string } = {},
  ): Promise<{
    schedules: ScheduleEntry[];
    /** Exact tenant-scoped count under the same filters. */
    total: number;
  }> {
    const qs = query.workflow_id ? `?workflow_id=${encodeURIComponent(query.workflow_id)}` : "";
    return this.request("GET", `/v1/schedules${qs}`);
  },

  createSchedule(
    this: EngineClient,
    body: {
      workflow_id: string;
      cron: string;
      timezone?: string;
      execution_mode?: "dev" | "prod";
      paused?: boolean;
      input?: unknown;
    },
  ): Promise<ScheduleUpsertResponse> {
    return this.request("POST", "/v1/schedules", body);
  },

  updateSchedule(
    this: EngineClient,
    id: string,
    patch: {
      cron?: string;
      timezone?: string;
      execution_mode?: "dev" | "prod";
      paused?: boolean;
      input?: unknown;
    },
  ): Promise<ScheduleEntry> {
    return this.request("PUT", `/v1/schedules/${encodeURIComponent(id)}`, patch);
  },

  deleteSchedule(this: EngineClient, id: string): Promise<{ id: string; deleted: boolean }> {
    return this.request("DELETE", `/v1/schedules/${encodeURIComponent(id)}`);
  },
};
