import type { components } from "@cli-core/engine-api/openapi";
import type { TranslationKey } from "@/lib/i18n";

type Schemas = components["schemas"];

export type WorkflowPreviewDraft = Schemas["ExecutionRunDraftDefinition"];

export type WorkflowPreviewSource =
  | { source: "draft"; definition: WorkflowPreviewDraft; input?: Record<string, unknown> }
  | { source: "step"; step: Schemas["ExecutionRunStep"] };

export function workflowPreviewRequest(
  source: WorkflowPreviewSource,
): Schemas["ExecutionRunDraftBody"] | Schemas["ExecutionRunStepBody"] {
  return { ...source, hold_writes: true as const };
}

export function workflowPreviewDefinition(
  definition: Record<string, unknown>,
  steps: readonly Record<string, unknown>[],
): WorkflowPreviewDraft {
  return {
    ...definition,
    name: typeof definition.name === "string" ? definition.name : "",
    steps: [...steps],
  };
}

export type PreviewFailure = { message: string; code: string | null };

const PREVIEW_REFUSALS: Readonly<Record<string, TranslationKey>> = {
  caller_saved_workflow_required: "workflow.preview.refusal.savedRequired",
  caller_product_mismatch: "workflow.preview.refusal.productCaller",
};

export function previewFailure(error: unknown): PreviewFailure {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return {
    message: error instanceof Error ? error.message : String(error),
    code: typeof code === "string" && code ? code : null,
  };
}

export function previewRefusalKey(code: string | null): TranslationKey | null {
  return code && Object.hasOwn(PREVIEW_REFUSALS, code) ? (PREVIEW_REFUSALS[code] ?? null) : null;
}

export function runRefusalKey(error: unknown): TranslationKey | null {
  return previewFailure(error).code === "caller_product_mismatch" ? "run.productCaller" : null;
}
