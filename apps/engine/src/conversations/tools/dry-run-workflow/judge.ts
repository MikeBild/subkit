import type { RunResult } from "../../../execution/types.ts";
import { HELD_PREVIEW_WARNING_CODE } from "../../../execution/types.ts";
import type { WorkflowDef } from "../../../workflows/types.ts";
import { draftGoal } from "../../authoring-spec.ts";
import type { PreviewJudgeOutcome } from "../../preview-judge.ts";
import { runPreviewJudgeGate } from "../../preview-judge-gate.ts";
import type { JudgeBreakerState } from "../../types.ts";
import type { DryRunEnv, Warnings } from "./env.ts";

export interface JudgeState {
  judgeOutcome: PreviewJudgeOutcome | null;
  judgeBlocked: boolean;
  nextJudgeBreaker: JudgeBreakerState | undefined;
  judgeDoneSignal: Awaited<ReturnType<typeof runPreviewJudgeGate>>["doneSignal"];
  judgeEscalate: boolean;
  judgeHint: string | null;
}

export const UNJUDGED: JudgeState = {
  judgeOutcome: null,
  judgeBlocked: false,
  nextJudgeBreaker: undefined,
  judgeDoneSignal: null,
  judgeEscalate: false,
  judgeHint: null,
};

export async function judgePreview(
  env: DryRunEnv,
  run: RunResult,
  definition: WorkflowDef,
  runWarnings: Warnings,
): Promise<JudgeState> {
  const { ctx, draft } = env;
  const judgeGoal = draftGoal(draft);
  const gate = await runPreviewJudgeGate({
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    db: ctx.db,
    goal: judgeGoal.goal,
    goal_confirmed: judgeGoal.confirmed,
    spec: draft.spec ?? null,
    definition,
    steps: env.steps as unknown as Array<Record<string, unknown>>,
    run_steps: run.steps,
    final_output: run.output,
    output_schema: definition.output_schema ?? null,
    final_output_held: (run.warnings ?? []).some((w) => w.code === HELD_PREVIEW_WARNING_CODE),
    prior_breaker: ctx.getDraft().state?.judge_breaker ?? null,
    ...(env.signal ? { signal: env.signal } : {}),
  });
  let judgeHint: string | null = null;
  if (gate.warning?.code === "judge_goal_unconfirmed") judgeHint = gate.warning.message;
  else if (gate.warning) runWarnings.push(gate.warning);
  return {
    judgeOutcome: gate.judgeOutcome,
    judgeBlocked: gate.judgeBlocked,
    nextJudgeBreaker: gate.nextJudgeBreaker,
    judgeDoneSignal: gate.doneSignal,
    judgeEscalate: gate.escalate === true,
    judgeHint,
  };
}
