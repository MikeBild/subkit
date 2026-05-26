import type { PlanStepStatus } from "../repl/plan-cell.tsx";

export type WorkflowTrigger =
  | { kind: "schedule"; cron: string; tz: string }
  | { kind: "webhook"; source: string; events: string[] }
  | { kind: "request" };

export interface WorkflowIntent {
  name: string;
  slug?: string;
  trigger: WorkflowTrigger;
  steps: Array<{ key: string; kind: string; connector_slug?: string }>;
}

export interface ConnectorIntent {
  template_slug: string;
  name?: string;
  environment?: "dev" | "prod";
  auth_type?: string;
  base_url?: string;
}

export interface KnowledgeSourceIntent {
  file_path: string;
  title: string;
  mime_type: string;
  size_bytes: number;
}

export interface WorkflowSummary {
  id: string;
  version: number;
  name: string;
  trigger: WorkflowTrigger;
  preview_execution_id?: string;
}

export interface ConnectorSummary {
  id: string;
  slug: string;
  template_slug: string;
  probe?: { ok: boolean; status_code?: number; duration_ms?: number };
}

export interface KnowledgeSourceSummary {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  file_id?: string;
  link_failed?: boolean;
}

export interface Phase {
  name: string;
  status: PlanStepStatus;
  detail?: string;
}
