import { monthlyUsage } from "../../llm/accounting/index.ts";
import { countSkillTokens } from "../../llm/runtime/context-assembler.ts";
import { logger } from "../../logging/index.ts";
import {
  breakdownLogFields,
  cacheReadUsage,
  type TurnOutcome,
  tokenBreakdown,
  topSkillsByTokens,
} from "../core/loop.ts";
import { nextSuggestion } from "../streaming.ts";
import type { TurnEvent } from "../types.ts";
import { spendAllowsSuggestion, turnSpendNotice } from "./spend-notice.ts";
import { buildNextSuggestionFrame } from "./suggest-next-emitter.ts";
import type { RunLoopResult, TurnEnv, TurnState } from "./types.ts";

async function suggestionFrameFor(env: TurnEnv, outcome: TurnOutcome): Promise<TurnEvent> {
  const { p, events } = env;
  if (outcome.status === "abandoned") {
    return nextSuggestion({ suggestion: null, reason: "turn-abandoned", kind: null });
  }
  const spendAllows = await spendAllowsSuggestion(p);
  const budgetGuard = spendAllows ? undefined : () => false;
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
  const { p, events, prompt } = env;
  const usageAfter = await monthlyUsage(p.tenant_id, p.db).catch(() => env.usageBefore);
  const turnTokens = Math.max(0, usageAfter - env.usageBefore);
  const breakdown = tokenBreakdown(prompt?.token_counts);
  const spendNotice = await turnSpendNotice(p, env.spendBefore);
  const turnCache = cacheReadUsage({
    input_tokens: state.turnInputTokens,
    cache_read_tokens: state.turnCacheReadTokens,
    cache_creation_tokens: state.turnCacheCreationTokens,
    cache_reported: state.turnCacheReported,
  });
  events.push({
    type: "completed",
    status: outcome.status,
    usage: {
      turn_tokens: turnTokens,
      ...(state.promptTokensLastCall != null
        ? { prompt_tokens_last_call: state.promptTokensLastCall }
        : {}),
      turn_tokens_total: state.turnTokensTotal,
      ...turnCache,
      context_cap_tokens: env.contextCap,
      ...(spendNotice ? { spend_notice: spendNotice } : {}),
      ...(breakdown ? { breakdown } : {}),
    },
  });

  events.push(await suggestionFrameFor(env, outcome));

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
    turn_input_tokens: state.turnInputTokens,
    turn_cache_read_tokens: state.turnCacheReadTokens,
    turn_cache_creation_tokens: state.turnCacheCreationTokens,
    turn_cache_reported: state.turnCacheReported,
    turn_cache_read_pct: turnCache.cache_read_pct ?? null,
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
