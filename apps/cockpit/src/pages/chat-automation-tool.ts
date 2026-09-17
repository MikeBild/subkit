import type { ToolPart } from "@/components/ai-elements/tool";
import { toolNameOf } from "@/lib/tool-parts";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function chatAutomationTool(tool: ToolPart) {
  if (toolNameOf(tool) !== "review_workflow_automation" || tool.state !== "output-available")
    return null;
  if (!record(tool.output) || tool.output.ok === false) return null;
  const data = record(tool.output.data) ? tool.output.data : tool.output;
  if (
    data.kind !== "workflow_automation_review" ||
    typeof data.workflow_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.workflow_id) ||
    !Array.isArray(data.schedules)
  )
    return null;
  const environments = [
    ...new Set<"dev" | "prod">(
      data.schedules.flatMap(
        (row): Array<"dev" | "prod"> =>
          record(row) &&
          row.workflow_id === data.workflow_id &&
          (row.environment === "dev" || row.environment === "prod")
            ? [row.environment]
            : [],
      ),
    ),
  ];
  return { workflowId: data.workflow_id, environments };
}
