import type { components } from "@/api/schema";

export const REPORT_WORKFLOW_SLUG = "support-report-issue";

export type ReportWorkflow = components["schemas"]["WorkflowListItem"];

export function mayReportProblem(permissions: readonly string[]): boolean {
  return permissions.includes("workflow:run") && permissions.includes("workflow:read");
}

export function reportWorkflowOf(items: readonly ReportWorkflow[]): ReportWorkflow | null {
  const found = items.find((item) => item.slug === REPORT_WORKFLOW_SLUG);
  if (!found) return null;
  if (found.lifecycle === "archived" || found.invalid === true) return null;
  if (found.current_version_id === null) return null;
  if (found.connector_references.some((reference) => reference.reason !== "available")) return null;
  return found;
}
