import type { ToolPart } from "@/components/ai-elements/tool";
import { toolNameOf } from "@/lib/tool-parts";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function chatAutomationSummary(
  tool: ToolPart,
): "authorized" | "upstream" | "repair" | "review" | "unknown" {
  if (!chatAutomationTool(tool) || !record(tool.output)) return "unknown";
  const data = record(tool.output.data) ? tool.output.data : tool.output;
  const rows = (data.schedules as unknown[])
    .filter(record)
    .filter((row) => row.workflow_id === data.workflow_id);
  if (rows.length === 0) return "unknown";
  if (rows.every((row) => row.state === "authorized" && row.ready === true)) return "authorized";
  const blocked = rows.filter(
    (row) => record(row.review) && row.review.eligible_for_repeated_runs === false,
  );
  if (
    blocked.some((row) => {
      const review = row.review as Record<string, unknown>;
      const evidence = review.preview_evidence;
      return (
        record(evidence) &&
        Array.isArray(evidence.steps) &&
        evidence.steps.some(
          (step) =>
            record(step) &&
            step.held === true &&
            Array.isArray(review.unavailable_steps) &&
            !review.unavailable_steps.includes(step.step_id),
        )
      );
    })
  )
    return "upstream";
  if (blocked.length > 0) return "repair";
  if (rows.every((row) => record(row.review) && row.review.eligible_for_repeated_runs === true))
    return "review";
  return "unknown";
}

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
