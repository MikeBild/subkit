import type { StripKind } from "./workflow-strip.ts";

export const WORKFLOW_OPERATING_STATUSES = [
  "active",
  "waiting_approval",
  "waiting_connector",
  "failing",
  "stopped",
  "repair_required",
  "unapproved",
  "disabled",
  "unknown",
] as const;

export type WorkflowOperatingStatus = (typeof WORKFLOW_OPERATING_STATUSES)[number];

export function workflowOperatingStatus(kind: StripKind): WorkflowOperatingStatus {
  switch (kind) {
    case "approved":
    case "manual":
      return "active";
    case "apply":
    case "grant":
    case "expiring":
      return "waiting_approval";
    case "connector":
      return "waiting_connector";
    case "failing":
      return "failing";
    case "paused":
    case "stopped":
      return "stopped";
    case "invalid":
    case "repair":
    case "repairPrepared":
      return "repair_required";
    case "empty":
    case "unapproved":
      return "unapproved";
    case "disabled":
      return "disabled";
    case "loading":
    case "failed":
    case "unknown":
      return "unknown";
  }
}
