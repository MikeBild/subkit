import type { ResolvedPrincipal } from "../../auth/types.ts";
import { runExecution } from "../../execution/engine.ts";
import { sensitiveFailure, sensitiveRequestMeta } from "../../execution/sensitive-payload.ts";
import type {
  ExecutionMode,
  RunResult,
  SensitiveCheckVerdict,
  SensitiveOutputField,
} from "../../execution/types.ts";
import { logger } from "../../logging/index.ts";
import { recordExecutionDryRun } from "../../observability/instrumentation.ts";
import type { WorkflowDef } from "../../workflows/types.ts";
import { withLatestPreview } from "../authoring-state/index.ts";
import { buildLifecyclePayload } from "./authoring-contract.ts";
import type { ToolContext, ToolResult } from "./index.ts";
import { clearLastPreview } from "./last-preview-store.ts";
import {
  SENSITIVE_EXECUTION_UNSUPPORTED,
  sensitiveExecutionUnsupported,
} from "./sensitive-envelope.ts";

export const SENSITIVE_CONTENT_NOTE =
  "Content is withheld because this workflow is sensitive. Only metadata is shown; never guess or describe values.";

export interface SensitiveStepMetadata {
  id: string;
  kind: string;
  status: string;
  duration_ms: number | null;
  held: boolean;
  failure?: { code: string; message: string };
  pagination?: {
    strategy: string;
    pages: number;
    items: number;
    complete: boolean;
    truncated: boolean;
  };
}

export interface SensitiveTestRunSummary {
  status: "succeeded" | "failed";
  duration_ms: number;
  content_withheld: true;
  steps: SensitiveStepMetadata[];
  counts: { total: number; succeeded: number; failed: number; held: number };
  validation: SensitiveCheckVerdict;
  output_schema: SensitiveCheckVerdict;
  output: Record<string, SensitiveOutputField>;
  note: string;
}

const STEP_STATUSES = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "aborted",
  "timed_out",
  "skipped",
]);
const FAILED_STEP_STATUSES = new Set(["failed", "aborted", "timed_out"]);
const CHECK_VERDICTS = new Set<SensitiveCheckVerdict>([
  "passed",
  "failed",
  "not_defined",
  "not_run",
]);
const OUTPUT_TYPES = new Set<SensitiveOutputField["type"]>([
  "string",
  "number",
  "boolean",
  "null",
  "array",
  "object",
  "missing",
]);

function errorCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stepMetadata(step: RunResult["steps"][number]): SensitiveStepMetadata {
  const meta = sensitiveRequestMeta(step.request_meta);
  const pagination = meta && "pagination" in meta ? meta.pagination : undefined;
  const failure = step.error ? sensitiveFailure(errorCodeOf(step.error)) : null;
  return {
    id: step.step_key,
    kind: step.kind,
    status: STEP_STATUSES.has(step.status) ? step.status : "failed",
    duration_ms: typeof step.duration_ms === "number" ? step.duration_ms : null,
    held: step.held === true,
    ...(failure ? { failure: { code: failure.code, message: failure.message } } : {}),
    ...(pagination
      ? {
          pagination: {
            strategy: String(pagination.strategy),
            pages: finiteCount(pagination.pages),
            items: finiteCount(pagination.items),
            complete: pagination.complete === true,
            truncated: pagination.truncated === true,
          },
        }
      : {}),
  };
}

function verdictOf(value: unknown): SensitiveCheckVerdict {
  return CHECK_VERDICTS.has(value as SensitiveCheckVerdict)
    ? (value as SensitiveCheckVerdict)
    : "not_run";
}

function outputMetadata(shape: unknown): Record<string, SensitiveOutputField> {
  if (!shape || typeof shape !== "object" || Array.isArray(shape)) return {};
  return Object.fromEntries(
    Object.entries(shape as Record<string, unknown>).map(([key, raw]) => {
      const field = (raw ?? {}) as { type?: unknown; length?: unknown };
      const type = OUTPUT_TYPES.has(field.type as SensitiveOutputField["type"])
        ? (field.type as SensitiveOutputField["type"])
        : "missing";
      return [
        key,
        type === "array" ? { type, length: finiteCount(field.length) } : ({ type } as const),
      ];
    }),
  );
}

export function sensitiveTestRunSummary(
  run: RunResult,
  durationMs: number,
): SensitiveTestRunSummary {
  const steps = run.steps.map(stepMetadata);
  return {
    status: run.status === "succeeded" ? "succeeded" : "failed",
    duration_ms: Math.max(0, Math.round(durationMs)),
    content_withheld: true,
    steps,
    counts: {
      total: steps.length,
      succeeded: steps.filter((step) => step.status === "succeeded" && !step.held).length,
      failed: steps.filter((step) => FAILED_STEP_STATUSES.has(step.status)).length,
      held: steps.filter((step) => step.held).length,
    },
    validation: verdictOf(run.sensitive_checks?.validation),
    output_schema: verdictOf(run.sensitive_checks?.output_schema),
    output: outputMetadata(run.sensitive_checks?.output_shape),
    note: SENSITIVE_CONTENT_NOTE,
  };
}

function summaryLine(summary: SensitiveTestRunSummary): string {
  const { counts } = summary;
  const outcome =
    summary.status === "succeeded" && summary.output_schema !== "failed"
      ? "succeeded"
      : summary.status === "succeeded"
        ? "ran, but the output does not match output_schema"
        : "failed";
  return `Sensitive test run ${outcome}: ${counts.total} step(s), ${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.held} held. ${SENSITIVE_CONTENT_NOTE}`;
}

export async function runSensitiveDryRun(p: {
  ctx: ToolContext;
  definition: WorkflowDef;
  draftName: string | undefined;
  previewInput: unknown;
  environment: ExecutionMode;
  principal: ResolvedPrincipal | null;
}): Promise<ToolResult> {
  const { ctx } = p;
  clearLastPreview({ tenant_id: ctx.tenant_id, conversation_id: ctx.conversation_id });
  let run: RunResult;
  const startedAt = performance.now();
  try {
    run = await runExecution({
      db: ctx.db,
      tenant_id: ctx.tenant_id,
      source: {
        kind: "draft",
        definition: { ...p.definition, execution_privacy: "sensitive" },
        ...(p.draftName ? { name: p.draftName } : {}),
      },
      input: p.previewInput,
      options: {
        request_source: "chat",
        execution_mode: p.environment,
        execution_privacy: "sensitive",
        hold_writes: true,
        sensitive_metadata_preview: true,
        principal: p.principal,
        ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      },
    });
  } catch (error) {
    const failure = sensitiveFailure(errorCodeOf(error));
    logger.warn({
      module: "conversation_tool",
      action: "dry_run_workflow.sensitive_refused",
      msg: "sensitive metadata test run refused before execution",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      error_code: failure.code,
    });
    if (failure.code === SENSITIVE_EXECUTION_UNSUPPORTED) {
      return sensitiveExecutionUnsupported(
        "The encrypted metadata test run was refused. Call dry_run_workflow with mode schema_only to check the structure without reading content.",
      );
    }
    return {
      ok: false,
      error_code: failure.code,
      message: failure.message,
      next_best_actions: ["inspect_workflow_draft", "validate_draft"],
      data: { error_code: failure.code, content_withheld: true },
    };
  }

  const summary = sensitiveTestRunSummary(run, performance.now() - startedAt);
  const green = summary.status === "succeeded" && summary.output_schema !== "failed";
  const line = summaryLine(summary);
  for (const step of summary.steps) {
    ctx.onLog?.(
      step.status === "succeeded"
        ? "info"
        : FAILED_STEP_STATUSES.has(step.status)
          ? "error"
          : "warn",
      `step ${step.id} (${step.kind}) ${step.held ? "held" : step.status}${
        step.duration_ms != null ? ` · ${step.duration_ms}ms` : ""
      }`,
    );
  }
  const stopped = summary.steps.find((step) => step.status !== "succeeded");
  const nextDraft = withLatestPreview(
    { ...ctx.getDraft(), latest_preview: null },
    {
      ok: green,
      step_id: stopped?.id ?? summary.steps.at(-1)?.id ?? "(end)",
      summary: line,
      preview: null,
      step_traces: summary.steps.map((step) => ({
        step_id: step.id,
        kind: step.kind,
        status: step.status,
        duration_ms: step.duration_ms,
        ...(step.failure ? { error_code: step.failure.code } : {}),
      })),
      input: null,
    },
    "dry_run_workflow",
    "workflow_previewed",
  );
  await ctx.setDraft(nextDraft);
  recordExecutionDryRun({ tenant_id: ctx.tenant_id, source_kind: "workflow" });
  logger.info({
    module: "conversation_tool",
    action: "dry_run_workflow.sensitive_metadata_preview",
    msg: "sensitive draft test run completed with metadata only",
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    execution_id: run.execution_id,
    status: summary.status,
    steps_ran: summary.counts.total,
    steps_failed: summary.counts.failed,
    steps_held: summary.counts.held,
    validation: summary.validation,
    output_schema: summary.output_schema,
    dry_run_duration_ms: summary.duration_ms,
  });

  const firstFailure = summary.steps.find((step) => step.failure)?.failure?.code;
  const nextActions = green
    ? ["save_workflow_draft"]
    : ["inspect_workflow_draft", "edit_workflow_patch"];
  const nextPrompt = green
    ? "The sensitive test run is green. Report only the metadata, then call save_workflow_draft so the human approval gate decides."
    : "Fix the draft from the step kinds, statuses and safe failure codes only, then re-run dry_run_workflow. Values stay withheld.";
  return {
    ok: green,
    ...(green
      ? {}
      : {
          error_code:
            summary.status !== "succeeded"
              ? firstFailure
                ? `draft_step_failed:${firstFailure}`
                : "draft_step_failed"
              : "preview_needs_repair",
          message: line,
        }),
    data: buildLifecyclePayload(
      nextDraft,
      {
        execution_id: run.execution_id,
        summary: line,
        save_required: green,
        next_best_actions: nextActions,
        next_prompt: nextPrompt,
        sensitive_test_run: summary,
      },
      { readOnly: true },
    ),
  };
}
