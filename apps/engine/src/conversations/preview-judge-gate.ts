import { logger } from "../logging/logger.ts";
import { recordPreviewJudgeVerdict } from "../observability/instrumentation.ts";
import { workflowSpecDigest } from "../workflows/core/spec.ts";
import type { WorkflowSpec } from "../workflows/draft-schemas.ts";
import type { WorkflowDef } from "../workflows/types.ts";
import { SPEC_GOAL_GUIDANCE } from "./authoring-spec.ts";
import {
  buildJudgeDefinitionSummary,
  buildJudgeStepArtifacts,
  JUDGE_BREAKER_ESCALATE_AFTER,
  JUDGE_BREAKER_MAX_BLOCKS,
  judgePreview,
  type PreviewJudgeOutcome,
  workflowDefinitionFingerprint,
} from "./preview-judge.ts";
import type { JudgeBreakerState, JudgeVerdictMemo } from "./types.ts";

interface PreviewJudgeGateResult {
  judgeOutcome: PreviewJudgeOutcome | null;
  judgeBlocked: boolean;
  nextJudgeBreaker: JudgeBreakerState | undefined;
  warning: {
    step_key: null;
    code: "judge_goal_mismatch" | "judge_goal_unconfirmed";
    message: string;
  } | null;
  doneSignal: {
    attempts: number;
    missing: string[];
    guidance: string;
  } | null;
  escalate?: boolean;
}

function toVerdictMemo(fingerprint: string, outcome: PreviewJudgeOutcome): JudgeVerdictMemo | null {
  if (outcome.verdict === "skipped") return null;
  return {
    fingerprint,
    verdict: outcome.verdict,
    reason: outcome.reason,
    missing: outcome.missing,
  };
}

export async function runPreviewJudgeGate(p: {
  tenant_id: string;
  conversation_id: string;
  db: import("../db/client.ts").Db;
  goal: string | null;
  goal_confirmed?: boolean;
  spec?: WorkflowSpec | null;
  definition: WorkflowDef;
  steps: ReadonlyArray<Record<string, unknown>>;
  run_steps: Parameters<typeof buildJudgeStepArtifacts>[0];
  final_output?: unknown;
  output_schema?: Record<string, unknown> | null;
  final_output_held?: boolean;
  prior_breaker: JudgeBreakerState | null;
  signal?: AbortSignal;
}): Promise<PreviewJudgeGateResult> {
  let judgeOutcome: PreviewJudgeOutcome | null = null;
  let judgeBlocked = false;
  let nextJudgeBreaker: JudgeBreakerState | undefined;
  let doneSignal: PreviewJudgeGateResult["doneSignal"] = null;

  if (!p.goal) {
    judgeOutcome = { verdict: "skipped", reason: "no_goal", next_action: SPEC_GOAL_GUIDANCE };
    logger.warn({
      module: "conversation_tool",
      action: "judge.no_goal",
      msg: "green preview has no stashed goal — preview judge skipped, committing as before",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
    });
    recordPreviewJudgeVerdict({ verdict: "skipped", blocked: false });
    return { judgeOutcome, judgeBlocked, nextJudgeBreaker, warning: null, doneSignal };
  }

  const fingerprint = p.spec
    ? `${workflowDefinitionFingerprint(p.definition)}:${workflowSpecDigest(p.spec).slice(0, 16)}`
    : workflowDefinitionFingerprint(p.definition);
  const priorBlocks = p.prior_breaker?.blocks_since_commit ?? 0;
  const memo = p.prior_breaker?.last_verdict ?? null;

  if (memo && memo.fingerprint === fingerprint) {
    judgeOutcome = { verdict: memo.verdict, reason: memo.reason, missing: memo.missing };
    logger.info({
      module: "conversation_tool",
      action: "judge.memoized",
      msg: "reusing the memoized judge verdict for an unchanged preview — judge LLM call skipped",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      verdict: memo.verdict,
      fingerprint,
    });
  } else {
    judgeOutcome = await judgePreview({
      goal: p.goal,
      ...(p.spec ? { acceptance: { outputs: p.spec.outputs, delivery: p.spec.delivery } } : {}),
      definition_summary: buildJudgeDefinitionSummary(p.steps as Array<Record<string, unknown>>),
      step_artifacts: buildJudgeStepArtifacts(p.run_steps),
      final_output: p.final_output,
      output_schema: p.output_schema ?? null,
      final_output_held: p.final_output_held === true,
      tenant_id: p.tenant_id,
      db: p.db,
      ...(p.signal ? { signal: p.signal } : {}),
    });
  }

  if (judgeOutcome.verdict === "skipped") {
    recordPreviewJudgeVerdict({ verdict: "skipped", blocked: false });
    return { judgeOutcome, judgeBlocked, nextJudgeBreaker, warning: null, doneSignal };
  }

  if (judgeOutcome.verdict === "passes") {
    recordPreviewJudgeVerdict({ verdict: "passes", blocked: false });
    nextJudgeBreaker = {
      blocks_since_commit: priorBlocks,
      last_verdict: toVerdictMemo(fingerprint, judgeOutcome),
    };
    return { judgeOutcome, judgeBlocked, nextJudgeBreaker, warning: null, doneSignal };
  }

  if (p.goal_confirmed === false) {
    logger.info({
      module: "conversation_tool",
      action: "judge.advisory_unconfirmed_goal",
      msg: "preview judge found gaps against a goal no person has confirmed — reported as a hint, commit not blocked",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      verdict: judgeOutcome.verdict,
      fingerprint,
    });
    recordPreviewJudgeVerdict({ verdict: judgeOutcome.verdict, blocked: false });
    nextJudgeBreaker = {
      blocks_since_commit: priorBlocks,
      last_verdict: toVerdictMemo(fingerprint, judgeOutcome),
    };
    return {
      judgeOutcome,
      judgeBlocked,
      nextJudgeBreaker,
      warning: {
        step_key: null,
        code: "judge_goal_unconfirmed",
        message:
          `preview output may not satisfy the workflow's recorded goal (verdict: ${judgeOutcome.verdict}): ${judgeOutcome.reason}` +
          (judgeOutcome.missing.length > 0 ? ` Missing: ${judgeOutcome.missing.join("; ")}.` : "") +
          " No person has confirmed this goal, so this is a hint, not a block: confirm the goal with the user before relying on it.",
      },
      doneSignal,
    };
  }

  if (priorBlocks >= JUDGE_BREAKER_MAX_BLOCKS) {
    const attempts = priorBlocks + 1;
    const priorHolds = p.prior_breaker?.holds_at_cap ?? 0;
    const holdsAtCap = priorHolds + 1;
    const escalate = holdsAtCap >= JUDGE_BREAKER_ESCALATE_AFTER;
    logger.warn({
      module: "conversation_tool",
      action: escalate ? "judge.breaker_escalate" : "judge.breaker_advisory",
      msg: escalate
        ? "preview judge held at the cap repeatedly — model ignored the EXIT; FORCING an operator-choice escalation"
        : "preview judge blocked at/over the cap — edit loop exhausted; HOLD for operator decision (no auto-commit), terminal done-signal surfaced",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      verdict: judgeOutcome.verdict,
      fingerprint,
      blocks_since_commit: priorBlocks,
      holds_at_cap: holdsAtCap,
    });
    judgeBlocked = true;
    recordPreviewJudgeVerdict({ verdict: judgeOutcome.verdict, blocked: true });
    nextJudgeBreaker = {
      blocks_since_commit: priorBlocks,
      holds_at_cap: holdsAtCap,
      last_verdict: toVerdictMemo(fingerprint, judgeOutcome),
    };
    const missingText =
      judgeOutcome.missing.length > 0 ? judgeOutcome.missing.join("; ") : judgeOutcome.reason;
    doneSignal = {
      attempts,
      missing: judgeOutcome.missing,
      guidance: escalate
        ? `STOP. You have re-run dry_run_workflow ${holdsAtCap} times since the preview hit its limit and it STILL does not satisfy the goal (missing: ${missingText}). Do NOT call dry_run_workflow or edit_workflow_patch again. You MUST now ask the user to choose, in plain language: (a) commit the workflow as-is via save_workflow_draft, (b) abandon it, or (c) give you new information to try. Wait for their answer.`
        : `The preview still does not satisfy the goal after ${attempts} attempt${attempts === 1 ? "" : "s"}. ` +
          `The judge says the following remains missing: ${missingText}. ` +
          "The workflow was NOT committed. STOP editing and re-running dry_run_workflow — tell the user exactly what is missing and ask how to proceed; only if they confirm it is acceptable as-is, commit via save_workflow_draft.",
    };
    return {
      judgeOutcome,
      judgeBlocked,
      nextJudgeBreaker,
      warning: null,
      doneSignal,
      escalate,
    };
  }

  judgeBlocked = true;
  nextJudgeBreaker = {
    blocks_since_commit: priorBlocks + 1,
    last_verdict: toVerdictMemo(fingerprint, judgeOutcome),
  };
  logger.info({
    module: "conversation_tool",
    action: "judge.blocked_commit",
    msg: "preview judge verdict blocked the green-preview auto-commit",
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    verdict: judgeOutcome.verdict,
    missing: judgeOutcome.missing,
    fingerprint,
    blocks_since_commit: priorBlocks + 1,
  });
  recordPreviewJudgeVerdict({ verdict: judgeOutcome.verdict, blocked: true });

  const warning = {
    step_key: null,
    code: "judge_goal_mismatch" as const,
    message:
      `preview output does not satisfy the user's goal (verdict: ${judgeOutcome.verdict}): ${judgeOutcome.reason}` +
      (judgeOutcome.missing.length > 0 ? ` Missing: ${judgeOutcome.missing.join("; ")}` : ""),
  };

  return { judgeOutcome, judgeBlocked, nextJudgeBreaker, warning, doneSignal };
}
