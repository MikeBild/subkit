import { truncateStepPreviewForLlm } from "../../tools/truncate.ts";

export interface RawStepResultSource {
  step_key: string;
  kind: string;
  status: string;
  duration_ms?: number | null;
  request_meta?: unknown;
  held?: true;
  held_request?: unknown;
  output_preview?: unknown;
  raw_preview?: unknown;
  error?: unknown;
}

interface RawStepResult {
  step_id: string;
  kind: string;
  status: string;
  duration_ms?: number | null;
  input: unknown;
  output?: unknown;
  output_ref?: string;
  raw_output?: unknown;
  raw_output_ref?: string;
  error?: unknown;
}

export function buildRawStepResults(steps: ReadonlyArray<RawStepResultSource>): RawStepResult[] {
  return steps.map((s) => {
    const input =
      s.held_request !== undefined && s.held_request !== null
        ? s.held_request
        : s.kind === "request" && s.request_meta !== undefined && s.request_meta !== null
          ? s.request_meta
          : null;
    const outputForLlm =
      s.output_preview !== undefined && s.output_preview !== null
        ? truncateStepPreviewForLlm(s.output_preview)
        : null;
    const rawForLlm =
      s.raw_preview !== undefined && s.raw_preview !== null
        ? truncateStepPreviewForLlm(s.raw_preview)
        : null;
    return {
      step_id: s.step_key,
      kind: s.kind,
      status: s.status,
      ...(s.duration_ms != null ? { duration_ms: s.duration_ms } : {}),
      input,
      ...(outputForLlm
        ? {
            output: outputForLlm.data,
            ...(outputForLlm.raw_ref ? { output_ref: outputForLlm.raw_ref } : {}),
          }
        : {}),
      ...(rawForLlm
        ? {
            raw_output: rawForLlm.data,
            ...(rawForLlm.raw_ref ? { raw_output_ref: rawForLlm.raw_ref } : {}),
          }
        : {}),
      ...(s.error ? { error: s.error } : {}),
    };
  });
}
