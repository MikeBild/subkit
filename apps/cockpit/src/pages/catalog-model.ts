import {
  WORKFLOW_OPERATING_STATUSES,
  type WorkflowOperatingStatus,
} from "@shared/workflow-operating-status.ts";
import type { TranslationKey } from "@/lib/i18n";
import type { ListParams } from "@/lib/use-infinite-list";

export interface CatalogQueryState {
  q: string;
  kind?: "all" | "oauth" | "mcp" | "key";
  status: string;
  category: string;
  connector: string;
  health: "not_ok" | null;
  sort: string;
  order: "asc" | "desc";
}

export function catalogListParams(resource: string, state: CatalogQueryState): ListParams {
  const params: ListParams = { sort: state.sort, order: state.order };
  if (state.q) params.q = state.q;
  if (resource === "connectors" && state.kind && state.kind !== "all") params.kind = state.kind;
  if (state.category !== "all") params.category = state.category;
  if (resource === "workflows" && state.connector) params.connector = state.connector;
  if (resource === "connectors" && state.health === "not_ok") params.health = "not_ok";
  if (resource === "workflows" && state.status !== "all") params.operating_status = state.status;
  return params;
}

export type RecordValue = Record<string, unknown>;

export function recordTitle(record: RecordValue | undefined): string {
  for (const key of ["name", "display_name", "title", "filename", "slug"]) {
    const value = record?.[key];
    if (typeof value === "string" && value) return value;
  }
  return "—";
}

export function catalogOperatingStatus(value: unknown): WorkflowOperatingStatus {
  return typeof value === "string" &&
    (WORKFLOW_OPERATING_STATUSES as readonly string[]).includes(value)
    ? (value as WorkflowOperatingStatus)
    : "unknown";
}

export const OPERATING_STATUS_KEYS: Record<WorkflowOperatingStatus, TranslationKey> = {
  active: "status.active",
  waiting_approval: "workflowStrip.state.grant",
  waiting_connector: "workflowStrip.state.connector",
  failing: "workflowStrip.state.failing",
  stopped: "workflowStrip.state.stopped",
  repair_required: "automation.state.repair",
  unapproved: "workflowStrip.state.unapproved",
  disabled: "workflowStrip.state.disabled",
  unknown: "automation.state.unknown",
};
