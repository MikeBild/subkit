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

export type WorkflowVersionEntry = {
  id: string;
  version: number;
  note: string | null;
  created_at: string;
  legacy: boolean;
};

/** The engine's answer to "how is this workflow called" — the fields `sk` reads. */
export interface WorkflowInvocation {
  workflow_id: string;
  slug: string;
  base_url: string | null;
  http: {
    snippets: Record<"dev" | "prod", Record<"curl" | "node" | "python", string>> | null;
  };
}

// The engine returns history one page at a time; this is the largest page it
// serves.
const VERSION_PAGE_SIZE = 200;

export const workflowsMethods = {
  // --------------------------- Workflow versions ---------------------------
  /** Every committed version of a workflow, newest first. The engine pages
   *  the history, so this reads page after page until it has all of it.
   *  `legacy` marks a version that can be read but no longer restored. */
  async listWorkflowVersions(
    this: EngineClient,
    workflowId: string,
  ): Promise<{ items: WorkflowVersionEntry[]; total: number }> {
    const path = `/v1/workflows/${encodeURIComponent(workflowId)}/history`;
    const items: WorkflowVersionEntry[] = [];
    let total = 0;
    do {
      const page = await this.request<{ items: WorkflowVersionEntry[]; total: number }>(
        "GET",
        path,
        undefined,
        { limit: VERSION_PAGE_SIZE, offset: items.length },
      );
      total = page.total;
      if (page.items.length === 0) break;
      items.push(...page.items);
    } while (items.length < total);
    return { items, total };
  },
  /** How the workflow is called: the engine's own snippets and public address. */
  getWorkflowInvocation(this: EngineClient, workflowId: string): Promise<WorkflowInvocation> {
    return this.request("GET", `/v1/workflows/${encodeURIComponent(workflowId)}/invocation`);
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
