import type { ToolPart } from "@/components/ai-elements/tool";
import { toolNameOf } from "@/lib/tool-parts";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function automationRows(data: Record<string, unknown>): unknown[] {
  return [
    ...(Array.isArray(data.schedules) ? data.schedules : []),
    ...(Array.isArray(data.inbound_hooks) ? data.inbound_hooks : []),
  ];
}

function savedChange(
  data: Record<string, unknown>,
): { environment: "dev" | "prod"; review: unknown } | null {
  const change = data.saved_change;
  if (!record(change)) return null;
  const { environment } = change;
  if (environment !== "dev" && environment !== "prod") return null;
  return { environment, review: change.review };
}

function reviewData(tool: ToolPart): Record<string, unknown> | null {
  if (tool.state !== "output-available" || !record(tool.output)) return null;
  const name = toolNameOf(tool);
  if (name === "review_workflow_automation") {
    if (tool.output.ok === false) return null;
    return record(tool.output.data) ? tool.output.data : tool.output;
  }
  if (name === "run_workflow") {
    const data = record(tool.output.data) ? tool.output.data : tool.output;
    if (data.error_code !== "workflow_activation_required") return null;
    return record(data.automation_review) ? data.automation_review : null;
  }
  return null;
}

export function chatAutomationTool(tool: ToolPart) {
  const data = reviewData(tool);
  if (
    data?.kind !== "workflow_automation_review" ||
    typeof data.workflow_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.workflow_id) ||
    !Array.isArray(data.schedules)
  )
    return null;
  const change = savedChange(data);
  const environments = [
    ...new Set<"dev" | "prod">([
      ...automationRows(data).flatMap(
        (row): Array<"dev" | "prod"> =>
          record(row) &&
          row.workflow_id === data.workflow_id &&
          (row.environment === "dev" || row.environment === "prod")
            ? [row.environment]
            : [],
      ),
      ...(change ? [change.environment] : []),
    ]),
  ];
  return { workflowId: data.workflow_id, environments };
}

export function liveAutomationReviews(tools: Iterable<ToolPart>): Map<string, string> {
  const live = new Map<string, string>();
  for (const tool of tools) {
    const review = chatAutomationTool(tool);
    if (review && review.environments.length > 0) live.set(review.workflowId, tool.toolCallId);
  }
  return live;
}
