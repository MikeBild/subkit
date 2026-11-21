import type { StepDef } from "../../workflows/types.ts";

export interface DryRunWarning {
  step_key: string | null;
  code: string;
  message: string;
}

export interface DryRunStepSummary {
  step_key: string;
  kind: string;
  status: string;
  duration_ms: number | null;
  error: unknown;
  held?: true;
  output_preview?: unknown;
  request_meta?: unknown;
}

export interface ToolCallRow {
  tool: string;
  output: unknown;
}

export interface TrippedCode {
  code: string;
  count: number;
}

export interface UnsupportedPlaceholder {
  step_id: string;
  field: string;
  raw: string;
  code: string;
  did_you_mean: string;
}

const REPEATING_REPAIR_CODES: ReadonlySet<unknown> = new Set([
  "unresolved_identifier",
  "loop_over_unresolved",
  "transform_empty_extraction",
]);

const BLOCKING_REPAIR_CODES = new Set([
  "unresolved_identifier",
  "transform_empty_extraction",
  "loop_over_unresolved",
  "loop_body_empty",
  "output_contract_violation",
]);

const REPAIR_LOOP_THRESHOLD = 3;

export function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

export function isRunnableStep(candidate: unknown): candidate is StepDef {
  return typeof fieldOf(candidate, "kind") === "string";
}

export function invalidDraftStepId(steps: readonly unknown[]): string {
  const id = fieldOf(steps[0], "id");
  return typeof id === "string" ? id : "(invalid-draft)";
}

export function describeUnsupportedPlaceholders(errors: readonly UnsupportedPlaceholder[]): string {
  return errors
    .map(
      (e) =>
        `step \`${e.step_id}\`.${e.field}: \`${e.raw}\` (${e.code}) → use \`${e.did_you_mean}\``,
    )
    .join("; ");
}

export function trippedRepairCodes(rows: readonly ToolCallRow[]): TrippedCode[] {
  const codeCounts = new Map<unknown, number>();
  for (const r of rows) {
    if (r.tool !== "dry_run_workflow" && r.tool !== "run_workflow") continue;
    const ws = fieldOf(fieldOf(r.output, "data"), "warnings");
    if (!Array.isArray(ws)) continue;
    for (const w of ws) {
      const code = fieldOf(w, "code");
      if (REPEATING_REPAIR_CODES.has(code)) {
        codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
      }
    }
  }
  return [...codeCounts.entries()]
    .filter(([, n]) => n >= REPAIR_LOOP_THRESHOLD)
    .map(([code, n]) => ({ code: code as string, count: n }));
}

export function repairLoopMessage(tripped: readonly TrippedCode[]): string {
  const codesPretty = tripped.map((c) => `\`${c.code}\` × ${c.count}`).join(", ");
  return `stop — three or more previews in a row produced the same authoring-bug warning(s): ${codesPretty}. Re-reading the data-handling skill, asking the user for a clarification, or proposing a structurally different draft is the right move. Another preview with the same draft will produce the same warning.`;
}

export function dryRunStartLine(stepCount: number, environment: string): string {
  return `dry-running ${stepCount} step${plural(stepCount)} (env=${environment})`;
}

export function stepFixtureEnvelope(
  summary: DryRunStepSummary | undefined,
): Record<string, unknown> | null {
  if (summary?.status !== "succeeded" || summary.held === true || summary.output_preview == null) {
    return null;
  }
  const envelope: Record<string, unknown> = {
    data: summary.output_preview,
    duration_ms: summary.duration_ms ?? 0,
    error: summary.error ?? null,
  };
  const status = fieldOf(summary.request_meta, "status");
  if (typeof status === "number") envelope.status_code = status;
  const headers = fieldOf(summary.request_meta, "headers");
  if (typeof headers === "object" && headers !== null) envelope.headers = headers;
  return envelope;
}

export function stepLogLevel(status: string): "info" | "warn" | "error" {
  if (status === "succeeded") return "info";
  return status === "failed" || status === "timed_out" ? "error" : "warn";
}

export function stepLogLine(step: DryRunStepSummary): string {
  const errMsg = fieldOf(step.error, "message");
  const duration = step.duration_ms != null ? ` · ${step.duration_ms}ms` : "";
  const detail = typeof errMsg === "string" ? ` · ${errMsg}` : "";
  return `step ${step.step_key} (${step.kind}) ${step.status}${duration}${detail}`;
}

export function stoppedStepOf(steps: readonly DryRunStepSummary[]): {
  stoppedId: string | null;
  stoppedMessage: string | null;
} {
  const stopped =
    steps.find((s) => s.status === "failed") ?? steps.find((s) => s.status !== "succeeded");
  if (stopped === undefined) return { stoppedId: null, stoppedMessage: null };
  const message = stopped.status === "failed" ? fieldOf(stopped.error, "message") : null;
  return {
    stoppedId: stopped.step_key,
    stoppedMessage: typeof message === "string" ? message : null,
  };
}

export function normalizeRunWarnings(
  warnings:
    | ReadonlyArray<{ step_key?: string | null; code?: string; message?: string }>
    | undefined,
): DryRunWarning[] {
  return (warnings ?? []).map((w) => ({
    step_key: w.step_key ?? null,
    code: w.code ?? "unknown",
    message: w.message ?? "",
  }));
}

export function blockingRepairWarnings<W extends { code: string }>(warnings: readonly W[]): W[] {
  return warnings.filter((w) => BLOCKING_REPAIR_CODES.has(w.code));
}

export interface WarningsBanner<W> {
  count: number;
  codes: string[];
  summary: string;
  entries: W[];
}

export function warningsBannerOf<W extends { code: string }>(
  warnings: W[],
): WarningsBanner<W> | null {
  if (warnings.length === 0) return null;
  const codes = Array.from(new Set(warnings.map((w) => w.code))).sort();
  return {
    count: warnings.length,
    codes,
    summary: `${warnings.length} warning(s): ${codes.join(", ")}`,
    entries: warnings,
  };
}

export interface PreviewDecisionInput {
  dryRunGreen: boolean;
  dryRunRequiresRepair: boolean;
  judgeBlocked: boolean;
  judgeSkipped: boolean;
  judgeEscalate: boolean;
  doneGuidance: string | null;
  askBeforeWriting: boolean;
  saveDeclined: boolean;
  wouldReplacePersisted: boolean;
  stoppedForDraft: string;
}

export interface PreviewDecision {
  cleanPreview: boolean;
  greenPendingSave: boolean;
  judgeExhausted: boolean;
  nextActions: string[];
  nextPrompt: string;
}

function nextActionsOf(
  input: PreviewDecisionInput,
  greenOrPending: boolean,
  judgeExhausted: boolean,
): string[] {
  if (input.saveDeclined && input.dryRunGreen) return [];
  if (greenOrPending || input.judgeEscalate) return ["save_workflow_draft"];
  if (judgeExhausted) return ["save_workflow_draft", "edit_workflow_patch"];
  if (input.judgeBlocked)
    return ["edit_workflow_patch", "inspect_workflow_draft", "dry_run_workflow"];
  if (input.dryRunRequiresRepair) {
    return ["diagnose_latest_execution", "edit_workflow_patch", "inspect_workflow_draft"];
  }
  return ["inspect_workflow_draft", "edit_workflow_patch"];
}

function pendingSavePrompt(input: PreviewDecisionInput): string {
  if (!input.judgeSkipped) {
    return "Preview is green and judged. Call save_workflow_draft so the normal human approval gate decides whether to persist it.";
  }
  return input.wouldReplacePersisted
    ? "Preview is green, but no goal was set, so nothing judged it against one — and committing would REPLACE an existing persisted workflow. Not auto-committed. Tell the user which workflow would be replaced and let them decide, then call save_workflow_draft."
    : "Preview is green — call save_workflow_draft to persist it (the preview was not judged, so it is not auto-committed)";
}

function nextPromptOf(
  input: PreviewDecisionInput,
  cleanPreview: boolean,
  greenPendingSave: boolean,
): string {
  if (input.saveDeclined && input.dryRunGreen) {
    return "Preview is green. The user asked not to save, so stop here and report the result.";
  }
  if (cleanPreview) return "Committing the workflow";
  if (greenPendingSave) return pendingSavePrompt(input);
  if (input.judgeBlocked && input.doneGuidance !== null) return input.doneGuidance;
  if (input.judgeBlocked) {
    return "Revise the workflow so the preview satisfies the goal (edit_workflow_patch), then re-run dry_run_workflow";
  }
  if (input.dryRunRequiresRepair) return "Open diagnosis to see why the preview needs repair";
  return `Re-run preview after fixing step \`${input.stoppedForDraft}\``;
}

export function previewDecision(input: PreviewDecisionInput): PreviewDecision {
  const autoCommitAllowed = !input.askBeforeWriting && !input.saveDeclined;
  const autoUnjudgedCommit = autoCommitAllowed && !input.wouldReplacePersisted;
  const greenUnblocked = input.dryRunGreen && !input.judgeBlocked;
  const cleanPreview =
    greenUnblocked && autoCommitAllowed && (!input.judgeSkipped || autoUnjudgedCommit);
  const greenPendingSave = greenUnblocked && !cleanPreview;
  const judgeExhausted = input.judgeBlocked && input.doneGuidance !== null;
  return {
    cleanPreview,
    greenPendingSave,
    judgeExhausted,
    nextActions: nextActionsOf(input, greenUnblocked, judgeExhausted),
    nextPrompt: nextPromptOf(input, cleanPreview, greenPendingSave),
  };
}

export function previewErrorCode(input: {
  judgeEscalate: boolean;
  judgeBlocked: boolean;
  runStatus: string;
  steps: readonly DryRunStepSummary[];
}): string {
  if (input.judgeEscalate) return "preview_judge_exhausted";
  if (input.judgeBlocked) return "preview_judge_failed";
  if (input.runStatus === "succeeded") return "preview_needs_repair";
  const failed = input.steps.find((s) => s.status !== "succeeded");
  const code = fieldOf(failed?.error, "code");
  return code ? `draft_step_failed:${String(code)}` : "draft_step_failed";
}

export type JudgeVerdict =
  | { verdict: "passes" | "partial" | "failed"; reason: string; missing: string[] }
  | { verdict: "skipped" };

export interface PreviewSummaryInput {
  runStatus: string;
  stepsRan: number;
  stoppedForDraft: string;
  stoppedMessage: string | null;
  lastStepSummary: string | undefined;
  runErrorMessage: string | undefined;
  judgeOutcome: JudgeVerdict | null;
  judgeBlocked: boolean;
  doneAttempts: number | null;
  repairCount: number;
}

function missingSuffix(missing: readonly string[]): string {
  return missing.length > 0 ? ` Missing: ${missing.join("; ")}.` : "";
}

export function previewSummaryOf(input: PreviewSummaryInput): string {
  if (input.runStatus !== "succeeded") {
    const reason =
      input.stoppedMessage ?? input.lastStepSummary ?? input.runErrorMessage ?? "unknown error";
    return `Run stopped at step \`${input.stoppedForDraft}\`: ${reason}`;
  }
  const ran = `Ran ${input.stepsRan} step${plural(input.stepsRan)}`;
  const judged = input.judgeOutcome;
  if (input.judgeBlocked && judged !== null && judged.verdict !== "skipped") {
    const verdict = `(judge verdict: ${judged.verdict}): ${judged.reason}${missingSuffix(judged.missing)}`;
    if (input.doneAttempts !== null) {
      return `${ran} without errors, but after ${input.doneAttempts} attempts the preview still does not satisfy the user's goal ${verdict} It was NOT committed. STOP re-running dry_run_workflow — tell the user what is missing and ask how to proceed, or commit as-is via save_workflow_draft.`;
    }
    return `${ran} without errors, but the preview does not satisfy the user's goal ${verdict} Fix via edit_workflow_patch and re-run dry_run_workflow — or, after the user explicitly confirms, commit anyway via save_workflow_draft.`;
  }
  return `${ran}, but the preview needs repair — ${input.repairCount} blocking warning${plural(input.repairCount)}. Fix the flagged step before committing.`;
}

export function heldReadHintOf(steps: readonly DryRunStepSummary[]): string | null {
  const heldStepCount = steps.filter((s) => s.held).length;
  const skippedDependentCount = steps.filter(
    (s) => fieldOf(s.error, "code") === "skipped_dependency_held",
  ).length;
  if (heldStepCount === 0 || skippedDependentCount === 0) return null;
  return `${heldStepCount} step(s) were HELD as writes and ${skippedDependentCount} dependent step(s) were skipped, so the preview could not produce a complete result. Only a verified read-only HTTP POST search endpoint supports the \`side_effects: "read"\` override. This label cannot authorize SQL writes, GraphQL mutations, or remote MCP tool calls. Keep those effects held, or request explicit approval for a live write run.`;
}

export function totalDurationMs(steps: ReadonlyArray<{ duration_ms: number | null }>): number {
  return steps.reduce((acc, s) => acc + (s.duration_ms ?? 0), 0);
}

export function previewClassification(input: {
  needsRepair: boolean;
  lastClassification: string | undefined;
  runStatus: string;
}): string {
  if (input.needsRepair) return "needs_repair";
  return input.lastClassification ?? (input.runStatus === "succeeded" ? "ok" : "driver_error");
}
