// The judge gate for green dry-runs (Fix C / P3) — extracted from
// dry_run_workflow so the tool stays focused on orchestration and the
// semantic-gate decision has a single owner.
//
// A green dry-run is a STRUCTURAL signal; the judge asks the semantic
// question — "does this preview satisfy the user's goal?" — in ONE
// deterministic LLM call BEFORE the auto-commit. `partial`/`failed`
// joins the requires_repair path (no auto-commit; verdict + missing
// items returned for repair); the explicit save path incl. force_commit
// remains the operator escape hatch. Skips (no goal stashed on the
// draft / judge infrastructure unavailable) never block — the commit
// proceeds exactly as before this feature existed.
//
// Convergence (P3):
//   - Memoization. Before calling the judge, if the current definition
//     fingerprint matches the last judged verdict on the draft, the
//     cached verdict is reused and the judge LLM call is SKIPPED — an
//     unchanged re-preview never re-judges.
//   - Circuit-breaker = blocks-since-last-commit. The block counter is
//     MONOTONIC per-draft (NOT per-fingerprint): it increments on every
//     block regardless of whether the model edited the definition, and
//     resets only on commit. After JUDGE_BREAKER_MAX_BLOCKS the verdict
//     degrades to advisory (attached + logged, non-blocking → the
//     auto-commit proceeds), so a model churning edits still converges.
//   - Terminal done-signal. At/over the cap (the block that would
//     degrade to advisory) the result carries an explicit EXIT
//     instruction: stop editing, tell the user what's missing, ask how
//     to proceed — instead of yet another silent requires_repair.

import { logger } from "../logging/logger.ts";
import { recordPreviewJudgeVerdict } from "../observability/instrumentation.ts";
import type { WorkflowDef } from "../workflows/types.ts";
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

export interface PreviewJudgeGateResult {
  judgeOutcome: PreviewJudgeOutcome | null;
  judgeBlocked: boolean;
  /** undefined = leave the stored breaker untouched. */
  nextJudgeBreaker: JudgeBreakerState | undefined;
  /** The judge_goal_mismatch warning to append when blocked. */
  warning: { step_key: null; code: "judge_goal_mismatch"; message: string } | null;
  /**
   * Terminal done-signal (P3). Present when the judge would block but
   * the breaker is at/over the cap — the gate degrades the verdict to
   * advisory (auto-commit proceeds) and surfaces this EXIT guidance so
   * the model stops editing and asks the user instead of looping.
   */
  doneSignal: {
    attempts: number;
    missing: string[];
    guidance: string;
  } | null;
  /**
   * Hard escalation (P3 hardening). True once the preview has been HELD at
   * the block cap `JUDGE_BREAKER_ESCALATE_AFTER` extra times — i.e. the model
   * kept re-running dry_run_workflow despite the terminal done-signal. The
   * consumer then emits a forced operator-choice envelope (commit-as-is /
   * abandon / more guidance) instead of yet another silent `ok:false`, so an
   * ignored EXIT cannot spin forever.
   */
  escalate?: boolean;
}

/**
 * Map a non-skipped judge outcome to the memo persisted on the draft so
 * an unchanged re-preview can reuse it without a fresh LLM call.
 */
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
  definition: WorkflowDef;
  steps: ReadonlyArray<Record<string, unknown>>;
  run_steps: Parameters<typeof buildJudgeStepArtifacts>[0];
  /** The run's resolved final output (post output_transform) — the format
   *  check evaluates this, not the step artifacts. */
  final_output?: unknown;
  prior_breaker: JudgeBreakerState | null;
  /** Turn/pipeline abort signal (P1) threaded into the judge call. */
  signal?: AbortSignal;
}): Promise<PreviewJudgeGateResult> {
  let judgeOutcome: PreviewJudgeOutcome | null = null;
  let judgeBlocked = false;
  let nextJudgeBreaker: JudgeBreakerState | undefined;
  let doneSignal: PreviewJudgeGateResult["doneSignal"] = null;

  if (!p.goal) {
    judgeOutcome = { verdict: "skipped", reason: "no_goal" };
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

  const fingerprint = workflowDefinitionFingerprint(p.definition);
  const priorBlocks = p.prior_breaker?.blocks_since_commit ?? 0;
  const memo = p.prior_breaker?.last_verdict ?? null;

  // Memoized verdict (P3): an unchanged re-preview (same fingerprint)
  // reuses the cached verdict and skips the judge LLM call entirely.
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
      definition_summary: buildJudgeDefinitionSummary(p.steps as Array<Record<string, unknown>>),
      step_artifacts: buildJudgeStepArtifacts(p.run_steps),
      final_output: p.final_output,
      tenant_id: p.tenant_id,
      db: p.db,
      ...(p.signal ? { signal: p.signal } : {}),
    });
  }

  if (judgeOutcome.verdict === "skipped") {
    // `judge.unavailable` already logged inside judgePreview.
    recordPreviewJudgeVerdict({ verdict: "skipped", blocked: false });
    return { judgeOutcome, judgeBlocked, nextJudgeBreaker, warning: null, doneSignal };
  }

  if (judgeOutcome.verdict === "passes") {
    // A passing verdict refreshes the memo so a re-preview short-circuits
    // straight to the commit path.
    recordPreviewJudgeVerdict({ verdict: "passes", blocked: false });
    nextJudgeBreaker = {
      blocks_since_commit: priorBlocks,
      last_verdict: toVerdictMemo(fingerprint, judgeOutcome),
    };
    return { judgeOutcome, judgeBlocked, nextJudgeBreaker, warning: null, doneSignal };
  }

  // partial / failed. The breaker counts blocks since the last commit;
  // the (priorBlocks)-th block is the one at the cap that degrades to
  // advisory and emits the terminal done-signal.
  if (priorBlocks >= JUDGE_BREAKER_MAX_BLOCKS) {
    const attempts = priorBlocks + 1;
    // Count holds AT the cap. The cap is hit once; every subsequent re-run
    // while still failing is a hold the model should not have made (it was
    // told to stop). After ESCALATE_AFTER such holds, force an operator choice.
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
    // The breaker breaks the edit→dry-run→block LOOP, NOT the quality gate:
    // a still-unsatisfied preview must NEVER auto-commit (that minted empty /
    // goal-violating workflows inline). Keep `judgeBlocked = true` so the
    // consumer withholds the commit, AND surface the terminal done-signal so
    // the model STOPS re-running dry_run_workflow and instead tells the user
    // what is missing / offers an explicit commit-as-is via save_workflow_draft.
    judgeBlocked = true;
    recordPreviewJudgeVerdict({ verdict: judgeOutcome.verdict, blocked: true });
    // Hold the block counter where it is (do NOT reset — only a real commit
    // resets it) and advance the at-cap hold counter so an ignored EXIT
    // escalates rather than looping silently forever.
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

  // Below the cap: BLOCK the auto-commit and increment the monotonic
  // counter regardless of fingerprint change.
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
