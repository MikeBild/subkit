// The judge gate for green dry-runs (Fix C) — extracted from
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
// Circuit-breaker (anti-churn): the judge may BLOCK at most
// JUDGE_BREAKER_MAX_BLOCKS times per definition fingerprint; after that
// the verdict degrades to advisory (attached + logged, non-blocking)
// until the definition changes — a new fingerprint implicitly resets
// the counter.

import { logger } from "../logging/logger.ts";
import { recordPreviewJudgeVerdict } from "../observability/instrumentation.ts";
import type { WorkflowDef } from "../workflows/types.ts";
import {
  buildJudgeDefinitionSummary,
  buildJudgeStepArtifacts,
  JUDGE_BREAKER_MAX_BLOCKS,
  judgePreview,
  type PreviewJudgeOutcome,
  workflowDefinitionFingerprint,
} from "./preview-judge.ts";
import type { JudgeBreakerState } from "./types.ts";

export interface PreviewJudgeGateResult {
  judgeOutcome: PreviewJudgeOutcome | null;
  judgeBlocked: boolean;
  /** undefined = leave the stored breaker untouched. */
  nextJudgeBreaker: JudgeBreakerState | undefined;
  /** The judge_goal_mismatch warning to append when blocked. */
  warning: { step_key: null; code: "judge_goal_mismatch"; message: string } | null;
}

export async function runPreviewJudgeGate(p: {
  tenant_id: string;
  conversation_id: string;
  db: import("../db/client.ts").Db;
  goal: string | null;
  definition: WorkflowDef;
  steps: ReadonlyArray<Record<string, unknown>>;
  run_steps: Parameters<typeof buildJudgeStepArtifacts>[0];
  prior_breaker: JudgeBreakerState | null;
}): Promise<PreviewJudgeGateResult> {
  let judgeOutcome: PreviewJudgeOutcome | null = null;
  let judgeBlocked = false;
  let nextJudgeBreaker: JudgeBreakerState | undefined;

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
  } else {
    judgeOutcome = await judgePreview({
      goal: p.goal,
      definition_summary: buildJudgeDefinitionSummary(p.steps as Array<Record<string, unknown>>),
      step_artifacts: buildJudgeStepArtifacts(p.run_steps),
      tenant_id: p.tenant_id,
      db: p.db,
    });
    if (judgeOutcome.verdict === "skipped") {
      // `judge.unavailable` already logged inside judgePreview.
      recordPreviewJudgeVerdict({ verdict: "skipped", blocked: false });
    } else if (judgeOutcome.verdict === "passes") {
      recordPreviewJudgeVerdict({ verdict: "passes", blocked: false });
    } else {
      const fingerprint = workflowDefinitionFingerprint(p.definition);
      const blocksSoFar =
        p.prior_breaker && p.prior_breaker.fingerprint === fingerprint ? p.prior_breaker.blocks : 0;
      if (blocksSoFar >= JUDGE_BREAKER_MAX_BLOCKS) {
        logger.warn({
          module: "conversation_tool",
          action: "judge.breaker_advisory",
          msg: "preview judge blocked this definition twice already — verdict degraded to advisory, auto-commit proceeds",
          tenant_id: p.tenant_id,
          conversation_id: p.conversation_id,
          verdict: judgeOutcome.verdict,
          fingerprint,
          blocks: blocksSoFar,
        });
        recordPreviewJudgeVerdict({ verdict: judgeOutcome.verdict, blocked: false });
      } else {
        judgeBlocked = true;
        nextJudgeBreaker = { fingerprint, blocks: blocksSoFar + 1 };
        logger.info({
          module: "conversation_tool",
          action: "judge.blocked_commit",
          msg: "preview judge verdict blocked the green-preview auto-commit",
          tenant_id: p.tenant_id,
          conversation_id: p.conversation_id,
          verdict: judgeOutcome.verdict,
          missing: judgeOutcome.missing,
          fingerprint,
          blocks: blocksSoFar + 1,
        });
        recordPreviewJudgeVerdict({ verdict: judgeOutcome.verdict, blocked: true });
      }
    }
  }

  const warning =
    judgeBlocked && judgeOutcome && judgeOutcome.verdict !== "skipped"
      ? {
          step_key: null,
          code: "judge_goal_mismatch" as const,
          message:
            `preview output does not satisfy the user's goal (verdict: ${judgeOutcome.verdict}): ${judgeOutcome.reason}` +
            (judgeOutcome.missing.length > 0 ? ` Missing: ${judgeOutcome.missing.join("; ")}` : ""),
        }
      : null;

  return { judgeOutcome, judgeBlocked, nextJudgeBreaker, warning };
}
