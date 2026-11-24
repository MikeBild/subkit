import type { ExecutionDetail, ExecutionStep } from "../engine-client/executions.ts";

export type ExecutionResult =
  | { kind: "markdown"; markdown: string; truncated: boolean }
  | { kind: "step"; output: unknown; storageUri: string | null };

export const resolveExecutionResult = (
  execution: Pick<ExecutionDetail, "result_markdown" | "result_markdown_truncated">,
  steps: readonly ExecutionStep[],
): ExecutionResult => {
  const markdown = execution.result_markdown;
  if (typeof markdown === "string" && markdown.length > 0)
    return { kind: "markdown", markdown, truncated: execution.result_markdown_truncated === true };
  const lastStep = steps.at(-1);
  return {
    kind: "step",
    output: lastStep?.output_preview ?? lastStep?.result_preview ?? null,
    storageUri: lastStep?.result_storage_uri ?? null,
  };
};
