export type { PlanStep, PlanStepStatus } from "../repl/plan-cell.tsx";

export type WorkflowTrigger =
  | { kind: "schedule"; cron: string; tz: string }
  | { kind: "webhook"; source: string; events: string[] }
  | { kind: "request" };

export interface WorkflowIntent {
  kind: "workflow";
  name: string;
  slug?: string;
  trigger: WorkflowTrigger;
  action?: "Create" | "Update";
  steps: Array<{ key: string; kind: string; connector_slug?: string }>;
}

export interface ConnectorIntent {
  kind: "connector";
  action?: "Create" | "Update";
  template_slug?: string;
  name?: string;
  environment?: "dev" | "prod";
  auth_type?: string;
  base_url?: string;
}

export interface KnowledgeSourceIntent {
  kind: "knowledge_source";
  file_path: string;
  title: string;
  mime_type: string;
  size_bytes: number;
}

export interface UsageAccessEntry {
  via: string;
  label: string;
  command?: string;
  url?: string;
  tool?: string;
  detail?: string;
}

export interface FollowUpOption {
  label: string;
  value: string;
  detail?: string;
}

export interface ResourceUsage {
  inputs: Array<{ name: string; type: string; required: boolean }>;
  output: string | null;
  access: UsageAccessEntry[];
  follow_up: string;
  follow_up_options?: FollowUpOption[];
}

export interface WorkflowSummary {
  kind: "workflow";
  id: string;
  version: number;
  name: string;
  trigger: WorkflowTrigger;
  action?: "Created" | "Updated";
  preview_execution_id?: string;
  usage?: ResourceUsage;
}

export interface ConnectorSummary {
  kind: "connector";
  id: string;
  slug: string;
  template_slug?: string;
  probe?: { ok: boolean; status_code?: number; duration_ms?: number };
  usage?: ResourceUsage;
}

export interface KnowledgeSourceSummary {
  kind: "knowledge_source";
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  description?: string;
  tags?: string[];
  file_id?: string;
  link_failed?: boolean;
  usage?: ResourceUsage;
}
