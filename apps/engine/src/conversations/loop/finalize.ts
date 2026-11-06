import { monthlyUsage } from "../../llm/accounting/index.ts";
import { countSkillTokens } from "../../llm/core/context-assembler.ts";
import { logger } from "../../logging/logger.ts";
import {
  breakdownLogFields,
  cacheReadUsage,
  remainingMonthlyBudget,
  type TurnOutcome,
  tokenBreakdown,
  topSkillsByTokens,
} from "../core/loop.ts";
import { nextSuggestion } from "../streaming.ts";
import type { TurnEvent } from "../types.ts";
import { buildNextSuggestionFrame } from "./suggest-next-emitter.ts";
import type { RunLoopResult, TurnEnv, TurnState } from "./types.ts";

const SUGGEST_BUDGET_HEADROOM_TOKENS = 200;

async function suggestionFrameFor(
  env: TurnEnv,
  outcome: TurnOutcome,
  usageAfter: number,
): Promise<TurnEvent> {
  const { p, events, route } = env;
  if (outcome.status === "abandoned") {
    return nextSuggestion({ suggestion: null, reason: "turn-abandoned", kind: null });
  }
  const monthlyBudget = route.monthly_budget;
  const budgetGuard =
    monthlyBudget != null && monthlyBudget > 0
      ? () => usageAfter + SUGGEST_BUDGET_HEADROOM_TOKENS <= monthlyBudget
      : undefined;
  return buildNextSuggestionFrame({
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    events,
    db: p.db,
    ...(p.next_suggestion_suppress !== undefined
      ? { client_suppress: p.next_suggestion_suppress }
      : {}),
    ...(budgetGuard ? { budget_guard: budgetGuard } : {}),
  });
}

export async function finalizeTurn(
  env: TurnEnv,
  state: TurnState,
  outcome: TurnOutcome,
): Promise<RunLoopResult> {
  const { p, events, route, prompt } = env;
  const usageAfter = await monthlyUsage(p.tenant_id, p.db).catch(() => env.usageBefore);
  const turnTokens = Math.max(0, usageAfter - env.usageBefore);
  const remaining = remainingMonthlyBudget(route.monthly_budget, usageAfter);
  const breakdown = tokenBreakdown(prompt?.token_counts);
  events.push({
    type: "completed",
    status: outcome.status,
    usage: {
      turn_tokens: turnTokens,
      ...(state.promptTokensLastCall != null
        ? { prompt_tokens_last_call: state.promptTokensLastCall }
        : {}),
      turn_tokens_total: state.turnTokensTotal,
      ...cacheReadUsage(state.turnInputTokens, state.turnCacheReadTokens),
      remaining_monthly_budget_tokens: remaining,
      context_cap_tokens: env.contextCap,
      ...(breakdown ? { breakdown } : {}),
    },
  });

  events.push(await suggestionFrameFor(env, outcome, usageAfter));

  const topSkillBreakdown = prompt
    ? topSkillsByTokens(prompt.included_skills ?? [], prompt.token_counts?.skills, (skill) =>
        countSkillTokens(skill, p.runtime_context),
      )
    : null;
  logger.info({
    module: "conversation",
    action: "dialog.turn_end",
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    final_status: outcome.status,
    turn_tokens: turnTokens,
    remaining_monthly_budget_tokens: remaining,
    references_resolved: env.referenced.resolved.length,
    references_unresolved: env.referenced.unresolved.length,
    ...breakdownLogFields(breakdown),
    ...(topSkillBreakdown ? { top_skills_by_tokens: topSkillBreakdown } : {}),
  });

  const out: RunLoopResult = { events, status: outcome.status };
  if (outcome.committed_workflow_id) out.committed_workflow_id = outcome.committed_workflow_id;
  if (outcome.pending_elicitation_id) out.pending_elicitation_id = outcome.pending_elicitation_id;
  for (const key of Object.keys(env.tools)) {
    delete (env.tools as Record<string, unknown>)[key];
  }
  return out;
}
