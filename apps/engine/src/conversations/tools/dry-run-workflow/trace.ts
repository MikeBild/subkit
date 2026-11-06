import type { PreviewStepSummary } from "../../../execution/classify.ts";
import type { RunResult } from "../../../execution/types.ts";
import { truncateStepPreviewForLlm } from "../../../tools/truncate.ts";
import { buildScopeAtStep } from "../../../workflows/scope-shape.ts";
import type { StepDef } from "../../../workflows/types.ts";
import { fieldOf, stepLogLevel, stepLogLine } from "../../core/dry-run.ts";
import { stampStepTraceFingerprints } from "../../step-fingerprint.ts";
import type { ToolContext } from "../index.ts";

type RunStep = RunResult["steps"][number];

function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function errorCodeField(step: RunStep): Record<string, unknown> {
  const errorCode = fieldOf(step.error, "code");
  return typeof errorCode === "string" ? { error_code: errorCode } : {};
}

function truncatedField(value: unknown, key: string, refKey: string): Record<string, unknown> {
  if (!present(value)) return {};
  const truncated = truncateStepPreviewForLlm(value);
  return {
    [key]: truncated.data,
    ...(truncated.raw_ref ? { [refKey]: truncated.raw_ref } : {}),
  };
}

export function logStepOutcomes(ctx: ToolContext, run: RunResult): void {
  for (const step of run.steps) {
    ctx.onLog?.(stepLogLevel(step.status), stepLogLine(step));
  }
}

export function finalOutputFieldOf(run: RunResult): {
  finalOutputForLlm: ReturnType<typeof truncateStepPreviewForLlm> | null;
  finalOutputField: Record<string, unknown>;
} {
  const finalOutputForLlm = present(run.output) ? truncateStepPreviewForLlm(run.output) : null;
  const finalOutputField = finalOutputForLlm
    ? {
        final_output: finalOutputForLlm.data,
        ...(finalOutputForLlm.raw_ref ? { final_output_ref: finalOutputForLlm.raw_ref } : {}),
      }
    : {};
  return { finalOutputForLlm, finalOutputField };
}

export function persistedStepTracesOf(run: RunResult, steps: StepDef[]) {
  const unstamped = run.steps.map((s) => {
    const scope = present(s.output_preview) ? buildScopeAtStep(s.output_preview) : undefined;
    const persistedPreview = present(s.output_preview)
      ? truncateStepPreviewForLlm(s.output_preview).data
      : undefined;
    const persistedRawPreview = present(s.raw_preview)
      ? truncateStepPreviewForLlm(s.raw_preview).data
      : undefined;
    return {
      step_id: s.step_key,
      kind: s.kind,
      status: s.status,
      ...(s.duration_ms != null ? { duration_ms: s.duration_ms } : {}),
      ...(persistedPreview !== undefined ? { output_preview: persistedPreview } : {}),
      ...(persistedRawPreview !== undefined ? { raw_preview: persistedRawPreview } : {}),
      ...(scope ? { scope_at_step: scope } : {}),
      ...errorCodeField(s),
      ...(s.held
        ? { held: true, held_request: truncateStepPreviewForLlm(s.held_request).data }
        : {}),
    };
  });
  return stampStepTraceFingerprints(unstamped, steps as unknown as Array<Record<string, unknown>>);
}

export function stepTraceOf(run: RunResult): Array<Record<string, unknown>> {
  return run.steps.map((s) => {
    const scope = present(s.output_preview) ? buildScopeAtStep(s.output_preview) : null;
    const previewField = truncatedField(s.output_preview, "output_preview", "output_preview_ref");
    const rawField = truncatedField(s.raw_preview, "raw_preview", "raw_preview_ref");
    return {
      step_id: s.step_key,
      kind: s.kind,
      status: s.status,
      ...(s.duration_ms != null ? { duration_ms: s.duration_ms } : {}),
      ...(present(s.request_meta) ? { request_meta: s.request_meta } : {}),
      ...previewField,
      ...rawField,
      ...(scope ? { scope_at_step: scope } : {}),
      ...errorCodeField(s),
      ...(s.error ? { error: s.error } : {}),
    };
  });
}

export function lastStepFieldOf(lastStep: PreviewStepSummary | undefined): Record<string, unknown> {
  if (!lastStep) return {};
  return {
    last_step: {
      step_id: lastStep.step_id,
      kind: lastStep.kind,
      classification: lastStep.classification,
      duration_ms: lastStep.duration_ms,
      ...truncatedField(lastStep.output_preview, "output_preview", "output_preview_ref"),
      ...(lastStep.error ? { error: lastStep.error } : {}),
    },
  };
}
