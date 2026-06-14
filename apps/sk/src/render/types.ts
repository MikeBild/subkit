// Re-export the plan-step types from the REPL so call sites that only
// touch the render module don't need to dip into `../repl/plan-cell.tsx`
// for the structural shape. The actual runtime renderer (PlanCard) and
// the heuristic detector still live with the REPL because they are
// codex/Ink-specific.
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
  steps: Array<{ key: string; kind: string; connector_slug?: string }>;
}

export interface ConnectorIntent {
  kind: "connector";
  template_slug: string;
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

// Render-shape mirror of the engine's `ResourceUsage` payload
// (apps/engine/src/conversations/tools/usage-guidance.ts). sk is a thin
// client — these are parsed defensively from `data.usage` on persist
// envelopes, never imported from engine types.
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
  /** Structured execution-options picker — present only for workflow usage.
   *  Parsed defensively from the persist envelope; sk never imports engine types. */
  follow_up_options?: FollowUpOption[];
}

export interface WorkflowSummary {
  kind: "workflow";
  id: string;
  version: number;
  name: string;
  trigger: WorkflowTrigger;
  preview_execution_id?: string;
  usage?: ResourceUsage;
}

export interface ConnectorSummary {
  kind: "connector";
  id: string;
  slug: string;
  template_slug: string;
  probe?: { ok: boolean; status_code?: number; duration_ms?: number };
  usage?: ResourceUsage;
}

export interface KnowledgeSourceSummary {
  kind: "knowledge_source";
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  /** Auto-generated (or supplied) description — shown so the user sees enrichment happened. */
  description?: string;
  /** Auto-generated (or supplied) topical tags. */
  tags?: string[];
  file_id?: string;
  link_failed?: boolean;
  usage?: ResourceUsage;
}
