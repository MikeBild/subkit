import type { ToolPart } from "@/components/ai-elements/tool";
import { toolNameOf } from "@/lib/tool-parts";

export interface ChatSensitiveTestRun {
  succeeded: boolean;
  steps: { succeeded: number; failed: number; held: number };
  reads: Array<{ step: string; items: number; complete: boolean }>;
  checks: "passed" | "failed" | "none";
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

function checksOf(validation: unknown, outputSchema: unknown): ChatSensitiveTestRun["checks"] {
  const verdicts = [validation, outputSchema];
  if (verdicts.includes("failed")) return "failed";
  return verdicts.includes("passed") ? "passed" : "none";
}

export function chatSensitiveTestRun(tool: ToolPart): ChatSensitiveTestRun | null {
  if (toolNameOf(tool) !== "dry_run_workflow" || tool.state !== "output-available") return null;
  const output = tool.output;
  if (!record(output)) return null;
  const data = record(output.data) ? output.data : output;
  const summary = data.sensitive_test_run;
  if (!record(summary) || !record(summary.counts) || !Array.isArray(summary.steps)) return null;
  const succeeded = count(summary.counts.succeeded);
  const failed = count(summary.counts.failed);
  const held = count(summary.counts.held);
  if (succeeded === null || failed === null || held === null) return null;
  const checks = checksOf(summary.validation, summary.output_schema);
  const reads = summary.steps.flatMap((step) => {
    if (!record(step) || typeof step.id !== "string" || !record(step.pagination)) return [];
    const items = count(step.pagination.items);
    return items === null
      ? []
      : [{ step: step.id, items, complete: step.pagination.complete === true }];
  });
  return {
    succeeded: summary.status === "succeeded" && checks !== "failed",
    steps: { succeeded, failed, held },
    reads,
    checks,
  };
}
