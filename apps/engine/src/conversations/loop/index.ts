import { hasToolCall, stepCountIs } from "ai";
import { withTenantWork } from "../../execution/tenant-work.ts";
import { withHostedWork } from "../../queue/hosted-work.ts";
import { turnLoopBudgetStopCondition } from "../turn-helpers.ts";
import { runTurnAttempts } from "./attempts.ts";
import { closeTurnReply } from "./closing.ts";
import { finalizeTurn } from "./finalize.ts";
import { DEFAULT_BUDGET } from "./model-resolver.ts";
import { resolveTurnOutcome } from "./outcome.ts";
import { resolveTurnPalette } from "./palette.ts";
import { preflightTurn } from "./preflight.ts";
import { openTurn } from "./prepare.ts";
import { assembleTurnPrompt } from "./prompt.ts";
import { reviewTurnReply } from "./review.ts";
import { resolveTurnSkills } from "./skills.ts";
import {
  abstainedStopCondition,
  automationReviewStopCondition,
  committedStopCondition,
  noProgressRepairStopCondition,
  pausedStopCondition,
} from "./stop-conditions.ts";
import type { RunLoopParams, RunLoopResult, TurnEnv, TurnStopConditions } from "./types.ts";

export {
  _setConverseFirstChunkTimeoutMsForTests,
  CONVERSE_FIRST_CHUNK_TIMEOUT_MS,
} from "./attempt.ts";
export type { RunLoopParams, RunLoopResult } from "./types.ts";

function turnStopConditions(budget: number): TurnStopConditions {
  return [
    stepCountIs(budget),
    hasToolCall("ask_user_choice"),
    hasToolCall("ask_user_multi"),
    hasToolCall("ask_user_text"),
    hasToolCall("ask_user_form"),
    hasToolCall("schedule_task_check"),
    abstainedStopCondition,
    pausedStopCondition,
    automationReviewStopCondition,
    committedStopCondition,
    turnLoopBudgetStopCondition,
    noProgressRepairStopCondition,
  ];
}

export async function runLoop(p: RunLoopParams): Promise<RunLoopResult> {
  return withTenantWork(p.tenant_id, () =>
    withHostedWork(p.db, p.tenant_id, "chat", () => runLoopAdmitted(p)),
  );
}

async function runLoopAdmitted(p: RunLoopParams): Promise<RunLoopResult> {
  const { base, state } = await openTurn(p, p.step_budget ?? DEFAULT_BUDGET);
  const skills = await resolveTurnSkills(base, state);
  const { prompt, activeConnectorId, recentToolCalls } = await assembleTurnPrompt(
    base,
    state,
    skills,
  );
  const preflight = await preflightTurn(base, prompt);
  const palette = await resolveTurnPalette(
    base,
    state,
    skills,
    prompt,
    activeConnectorId,
    recentToolCalls,
  );
  const env: TurnEnv = {
    ...base,
    ...palette,
    prompt,
    contextCap: preflight.contextCap,
    estimatedPromptTokens: preflight.estimatedPromptTokens,
    stopWhen: turnStopConditions(base.budget),
  };
  await runTurnAttempts(env, state, preflight.messages);
  await closeTurnReply(env, state);
  await reviewTurnReply(env, state);
  const outcome = await resolveTurnOutcome(env, state);
  return finalizeTurn(env, state, outcome);
}
