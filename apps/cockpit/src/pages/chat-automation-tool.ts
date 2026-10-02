import type { ToolPart } from "@/components/ai-elements/tool";
import { toolNameOf } from "@/lib/tool-parts";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Everything that starts the workflow unattended: its schedules and, from an
 *  engine that reports them, its inbound webhooks. A webhook-only workflow
 *  used to read as "nothing here" and its card rendered empty. */
function automationRows(data: Record<string, unknown>): unknown[] {
  return [
    ...(Array.isArray(data.schedules) ? data.schedules : []),
    ...(Array.isArray(data.inbound_hooks) ? data.inbound_hooks : []),
  ];
}

/** A saved change that waits to be applied, with the environment a run of it
 *  would use. A workflow nothing starts automatically has only this. */
function savedChange(
  data: Record<string, unknown>,
): { environment: "dev" | "prod"; review: unknown } | null {
  const change = data.saved_change;
  if (!record(change)) return null;
  const { environment } = change;
  if (environment !== "dev" && environment !== "prod") return null;
  return { environment, review: change.review };
}

/**
 * The review payload of a tool part: a `review_workflow_automation` result, or
 * the `run_workflow` refusal that carries the same review. The refusal promises
 * the dialog in which the person applies the saved change; without reading it
 * here, that promise pointed at nothing.
 */
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

/**
 * Whether a tool part is a review card, and for which workflow.
 *
 * It answers only THAT: `environments` is non-empty when the result held
 * something to review. What the card then says and which buttons it offers is
 * not read from this snapshot — the card reads the workflow's current state
 * (`lib/automation-state.ts`), the same decision its page makes.
 */
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
