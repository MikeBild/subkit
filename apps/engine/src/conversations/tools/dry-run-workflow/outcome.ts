import type { PreviewStepSummary } from "../../../execution/classify.ts";
import type { RunResult } from "../../../execution/types.ts";
import { logger } from "../../../logging/logger.ts";
import type { WorkflowDef } from "../../../workflows/types.ts";
import {
  heldReadHintOf,
  type PreviewDecision,
  previewClassification,
  previewErrorCode,
  previewSummaryOf,
  totalDurationMs,
  warningsBannerOf,
} from "../../core/dry-run.ts";
import { proposeDryRunRepairs, workflowOutputSite } from "../../dry-run-repair.ts";
import { commitWorkflowAtomic } from "../../persistence/commit-workflow.ts";
import { workflowOutputEvaluation } from "../../preview-auto-repair.ts";
import type { DraftDocument } from "../../types.ts";
import { buildLifecyclePayload } from "../authoring-contract.ts";
import type { ToolResult } from "../index.ts";
import { previewEvidence } from "../preview-evidence.ts";
import type { DryRunEnv, Warnings } from "./env.ts";
import type { JudgeState } from "./judge.ts";
import { lastStepFieldOf } from "./trace.ts";

export interface PreviewReport {
  run: RunResult;
  definition: WorkflowDef;
  nextDraft: DraftDocument;
  runWarnings: Warnings;
  repairCount: number;
  dryRunRequiresRepair: boolean;
  judge: JudgeState;
  decision: PreviewDecision;
  saveDeclined: boolean;
  lastStep: PreviewStepSummary | undefined;
  stoppedId: string | null;
  stoppedMessage: string | null;
  stoppedForDraft: string;
  previewScope: Record<string, unknown>;
  stepTrace: Array<Record<string, unknown>>;
  trailingFields: Record<string, unknown>;
}

function summaryOf(run: RunResult, totalDryRunMs: number) {
  return {
    steps_ran: run.steps.length,
    duration_ms: totalDryRunMs,
    execution_id: run.execution_id,
  };
}

function judgeFields(judge: JudgeState): Record<string, unknown> {
  return {
    ...(judge.judgeOutcome ? { judge: judge.judgeOutcome } : {}),
    ...(judge.judgeHint ? { judge_hint: judge.judgeHint } : {}),
  };
}

export async function autoCommitResult(env: DryRunEnv, report: PreviewReport): Promise<ToolResult> {
  const { ctx } = env;
  const { run, judge } = report;
  const commitResult = await commitWorkflowAtomic({
    ctx,
    skipPriorApprovalCheck: true,
    reason: "auto_persist_on_green_dry_run",
    emitAutoPersistAudit: true,
    commitIntentKind: "save_workflow_draft",
    ...(judge.judgeOutcome
      ? {
          extraAuditMetadata: {
            judge_verdict: judge.judgeOutcome.verdict,
            judge_reason: judge.judgeOutcome.reason,
          },
        }
      : {}),
  });
  if (!commitResult.ok) {
    logger.warn({
      module: "conversation_tool",
      action: "dry_run_workflow.auto_commit_failed",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      error_code: (commitResult.data as { error_code?: unknown } | undefined)?.error_code ?? null,
    });
    return commitResult;
  }
  const committed =
    typeof commitResult.data === "object" && commitResult.data !== null
      ? (commitResult.data as Record<string, unknown>)
      : {};
  const versionChanged = committed.version_changed !== false;
  const totalDryRunMs = totalDurationMs(run.steps);
  logger.info({
    module: "conversation_tool",
    action: versionChanged
      ? "dry_run_workflow.auto_committed"
      : "dry_run_workflow.already_persisted",
    msg: versionChanged
      ? "green dry-run auto-persisted workflow inline"
      : "green dry-run matched the current workflow version",
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    workflow_id:
      typeof committed.workflow_id === "string"
        ? committed.workflow_id
        : (commitResult.committed_workflow_id ?? null),
    workflow_version: typeof committed.version === "number" ? committed.version : null,
    steps_ran: run.steps.length,
    dry_run_duration_ms: totalDryRunMs,
    execution_id: run.execution_id,
    warnings_count: report.runWarnings.length,
  });
  const done = judge.judgeDoneSignal;
  return {
    ok: true,
    data: {
      ...committed,
      auto_committed: versionChanged,
      auto_commit_reason: "auto_persist_on_green_dry_run",
      ...judgeFields(judge),
      ...(done
        ? {
            judge_done: {
              committed_as_is: true,
              attempts: done.attempts,
              missing: done.missing,
              next_action: done.guidance,
            },
          }
        : {}),
      dry_run_summary: summaryOf(run, totalDryRunMs),
      preview_evidence: previewEvidence(run.steps),
      step_trace: report.stepTrace,
      ...report.trailingFields,
    },
    ...(typeof commitResult.committed_workflow_id === "string"
      ? { committed_workflow_id: commitResult.committed_workflow_id }
      : {}),
  };
}

export function pendingSaveResult(env: DryRunEnv, report: PreviewReport): ToolResult {
  const { ctx } = env;
  const { run, decision } = report;
  const totalDryRunMs = totalDurationMs(run.steps);
  logger.info({
    module: "conversation_tool",
    action: "dry_run_workflow.green_pending_save",
    msg: "green dry-run not auto-persisted — awaiting explicit save",
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    steps_ran: run.steps.length,
    dry_run_duration_ms: totalDryRunMs,
    execution_id: run.execution_id,
    warnings_count: report.runWarnings.length,
  });
  return {
    ok: true,
    data: {
      auto_committed: false,
      save_required: !report.saveDeclined,
      next_best_actions: decision.nextActions,
      next_prompt: decision.nextPrompt,
      ...judgeFields(report.judge),
      dry_run_summary: summaryOf(run, totalDryRunMs),
      preview_evidence: previewEvidence(run.steps),
      step_trace: report.stepTrace,
      ...report.trailingFields,
    },
  };
}

export async function needsRepairResult(
  env: DryRunEnv,
  report: PreviewReport,
): Promise<ToolResult> {
  const { ctx } = env;
  const { run, definition, runWarnings, judge, decision, lastStep } = report;
  const previewInput = env.previewInput ?? null;
  const repairProposals = await proposeDryRunRepairs({
    steps: env.steps,
    runWarnings,
    runError: run.error ?? null,
    output: workflowOutputSite(definition),
    outputEvaluation: workflowOutputEvaluation({
      run,
      definition,
      scope: report.previewScope,
      input: previewInput,
    }),
    previewScope: report.previewScope,
    input: previewInput,
    tenant_id: ctx.tenant_id,
    db: ctx.db,
    ...(env.signal ? { signal: env.signal } : {}),
  });
  const done = judge.judgeDoneSignal;
  const errorCode = previewErrorCode({
    judgeEscalate: judge.judgeEscalate,
    judgeBlocked: judge.judgeBlocked,
    runStatus: run.status,
    steps: run.steps,
  });
  const previewSummary = previewSummaryOf({
    runStatus: run.status,
    stepsRan: run.steps.length,
    stoppedForDraft: report.stoppedForDraft,
    stoppedMessage: report.stoppedMessage,
    lastStepSummary: lastStep?.summary,
    runErrorMessage: run.error?.message,
    judgeOutcome: judge.judgeOutcome,
    judgeBlocked: judge.judgeBlocked,
    doneAttempts: done?.attempts ?? null,
    repairCount: report.repairCount,
  });
  const heldReadHint = heldReadHintOf(run.steps);
  const warningsBanner = warningsBannerOf(runWarnings);
  const needsRepair = report.dryRunRequiresRepair || judge.judgeBlocked;
  return {
    ok: false,
    error_code: errorCode,
    message: heldReadHint ? `${previewSummary} ${heldReadHint}` : previewSummary,
    data: buildLifecyclePayload(
      report.nextDraft,
      {
        steps_ran: run.steps.length,
        duration_ms: totalDurationMs(run.steps),
        classification: previewClassification({
          needsRepair,
          lastClassification: lastStep?.classification,
          runStatus: run.status,
        }),
        stopped_at_step_id: report.stoppedId,
        summary: previewSummary,
        ...(heldReadHint ? { held_read_hint: heldReadHint } : {}),
        execution_id: run.execution_id,
        next_best_actions: decision.nextActions,
        next_prompt: decision.nextPrompt,
        ...judgeFields(judge),
        ...(done
          ? {
              judge_done: {
                committed_as_is: false,
                escalate: judge.judgeEscalate,
                attempts: done.attempts,
                missing: done.missing,
                next_action: done.guidance,
              },
            }
          : {}),
        ...(warningsBanner ? { warning_summary: warningsBanner.summary } : {}),
        ...(warningsBanner ? { warnings_banner: warningsBanner } : {}),
        ...(runWarnings.length > 0 ? { warnings: runWarnings } : {}),
        ...(repairProposals.length > 0 ? { repair_proposals: repairProposals } : {}),
        preview_evidence: previewEvidence(run.steps),
        step_trace: report.stepTrace,
        ...report.trailingFields,
        ...lastStepFieldOf(lastStep),
      },
      { readOnly: true },
    ),
  };
}
