import { HELD_PREVIEW_WARNING_CODE, type RunResult } from "../../execution/index.ts";

interface ResultEnvelope {
  rawBody: unknown;
  held: boolean;
}

export function buildResultEnvelope(
  result: Pick<RunResult, "warnings" | "output" | "execution_id">,
): ResultEnvelope {
  const held =
    result.warnings?.some((warning) => warning.code === HELD_PREVIEW_WARNING_CODE) ?? false;
  if (held)
    return {
      held: true,
      rawBody: {
        status: "preparation",
        execution_id: result.execution_id,
        live_execution_authorized: false,
        message:
          "External effects were held. Review the exact workflow version and grant a finite execution authority in the workflow cockpit before requesting live runs. Unknown or dynamic effects still require concrete-run review.",
        output: result.output ?? null,
        warnings: result.warnings,
      },
    };
  const hasWarnings = (result.warnings?.length ?? 0) > 0;
  return {
    held: false,
    rawBody: hasWarnings
      ? { output: result.output ?? null, warnings: result.warnings }
      : (result.output ?? null),
  };
}
