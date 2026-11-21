import { classifyRunResult } from "../../../execution/classify.ts";
import {
  recordExecutionDryRun,
  recordExecutionWarningsEmitted,
} from "../../../observability/instrumentation.ts";
import { withJudgeBreaker, withLatestPreview } from "../../authoring-state/index.ts";
import {
  blockingRepairWarnings,
  type DryRunWarning,
  normalizeRunWarnings,
  previewDecision,
  stoppedStepOf,
} from "../../core/dry-run.ts";
import { declinesSaving } from "../../intent-detector.ts";
import { buildStepOutputFixtures, previewAutoRepairWarning } from "../../preview-auto-repair.ts";
import { computeScopeDriftWarnings } from "../../scope-drift.ts";
import type { ToolResult } from "../index.ts";
import { recordLastPreview } from "../last-preview-store.ts";
import { replacesPersistedWorkflow } from "../state-gate.ts";
import { buildRawStepResults } from "../step-results.ts";
import { unverifiedBoundaries } from "../unverified-boundaries.ts";
import type { DryRunEnv, PreviewRun, Warnings } from "./env.ts";
import { judgePreview, UNJUDGED } from "./judge.ts";
import { autoCommitResult, needsRepairResult, pendingSaveResult } from "./outcome.ts";
import {
  finalOutputFieldOf,
  logStepOutcomes,
  persistedStepTracesOf,
  stepTraceOf,
} from "./trace.ts";

export async function reportPreview(
  env: DryRunEnv,
  preview: PreviewRun,
  authorPermissionWarnings: readonly DryRunWarning[],
  inheritedReferencesField: Record<string, unknown>,
): Promise<ToolResult> {
  const { ctx, steps } = env;
  const { run, definition, autoRepair } = preview;
  const previewInput = env.previewInput ?? null;

  const previewScope = buildStepOutputFixtures(run.steps);
  if (Object.keys(previewScope).length > 0) {
    recordLastPreview({
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      scope: previewScope,
      input: previewInput,
    });
  }
  logStepOutcomes(ctx, run);

  const lastStepSummary = run.steps[run.steps.length - 1];
  const { stoppedId, stoppedMessage } = stoppedStepOf(run.steps);
  const fallbackStep = steps[steps.length - 1];
  const matchedStep = lastStepSummary
    ? (steps.find((s) => s.id === lastStepSummary.step_key) ?? fallbackStep)
    : undefined;
  const lastStep = lastStepSummary && matchedStep ? classifyRunResult(matchedStep, run) : undefined;
  const { finalOutputForLlm, finalOutputField } = finalOutputFieldOf(run);
  const stepResultsField = env.args.include_step_results
    ? { step_results: buildRawStepResults(run.steps) }
    : {};
  const stoppedForDraft = stoppedId ?? lastStep?.step_id ?? "(end)";
  const unverifiedBoundaryNotice = unverifiedBoundaries(steps, run.steps);
  const unverifiedBoundariesField = unverifiedBoundaryNotice
    ? { unverified_boundaries: unverifiedBoundaryNotice }
    : {};

  const runWarnings: Warnings = normalizeRunWarnings(run.warnings);
  runWarnings.push(...authorPermissionWarnings);
  if (autoRepair) runWarnings.push(previewAutoRepairWarning(autoRepair));
  const autoRepairField = autoRepair ? { auto_repair: autoRepair } : {};
  recordExecutionDryRun({ tenant_id: ctx.tenant_id, source_kind: "workflow" });
  if (runWarnings.length > 0) {
    recordExecutionWarningsEmitted({
      tenant_id: ctx.tenant_id,
      step_kind: "workflow",
      count: runWarnings.length,
    });
  }
  const repairCount = blockingRepairWarnings(runWarnings).length;
  const dryRunRequiresRepair = repairCount > 0;
  runWarnings.push(...computeScopeDriftWarnings(ctx.getDraft(), run.steps));

  const dryRunGreen = run.status === "succeeded" && !dryRunRequiresRepair;
  const judge = dryRunGreen ? await judgePreview(env, run, definition, runWarnings) : UNJUDGED;

  const persistedStepTraces = persistedStepTracesOf(run, steps);
  const draftForPreview =
    judge.nextJudgeBreaker !== undefined
      ? withJudgeBreaker(ctx.getDraft(), judge.nextJudgeBreaker)
      : ctx.getDraft();
  const nextDraft = withLatestPreview(
    draftForPreview,
    {
      ok: run.status === "succeeded",
      step_id: stoppedForDraft,
      summary: lastStep?.summary ?? `Run completed with status ${run.status}.`,
      preview: finalOutputForLlm?.data ?? lastStep?.output_preview ?? null,
      ...(runWarnings.length > 0 ? { warnings: runWarnings } : {}),
      ...(dryRunRequiresRepair || judge.judgeBlocked ? { requires_repair: true } : {}),
      step_traces: persistedStepTraces,
      input: previewInput,
    },
    "dry_run_workflow",
    "workflow_previewed",
  );
  await ctx.setDraft(nextDraft);

  const stepTrace = stepTraceOf(run);
  const saveDeclined = declinesSaving(ctx.recentUserMessage);
  const decision = previewDecision({
    dryRunGreen,
    dryRunRequiresRepair,
    judgeBlocked: judge.judgeBlocked,
    judgeSkipped: judge.judgeOutcome?.verdict === "skipped",
    judgeEscalate: judge.judgeEscalate,
    doneGuidance: judge.judgeDoneSignal?.guidance ?? null,
    askBeforeWriting: ctx.ask_before_writing === true,
    saveDeclined,
    wouldReplacePersisted: replacesPersistedWorkflow(ctx.getDraft().summary),
    stoppedForDraft,
  });
  const report = {
    run,
    definition,
    nextDraft,
    runWarnings,
    repairCount,
    dryRunRequiresRepair,
    judge,
    decision,
    saveDeclined,
    lastStep,
    stoppedId,
    stoppedMessage,
    stoppedForDraft,
    previewScope,
    stepTrace,
    trailingFields: {
      ...finalOutputField,
      ...autoRepairField,
      ...inheritedReferencesField,
      ...unverifiedBoundariesField,
      ...stepResultsField,
    },
  };
  if (decision.cleanPreview) return autoCommitResult(env, report);
  if (decision.greenPendingSave) return pendingSaveResult(env, report);
  return needsRepairResult(env, report);
}
