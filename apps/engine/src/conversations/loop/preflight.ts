import type { ModelMessage } from "ai";
import {
  actorFields,
  checkAndDecrement,
  checkBudget,
  contextCapFor,
  countModelMessagesTokens,
} from "../../llm/accounting/index.ts";
import { LlmContextTooLarge, LlmQuotaExhausted } from "../../llm/errors.ts";
import { recordConversationBudgetReport } from "../../llm/runtime/conversation-budget-report.ts";
import { logger } from "../../logging/logger.ts";
import { recordLlmQuotaExhausted } from "../../observability/instrumentation.ts";
import { timePhase, timePhaseAsync } from "../../observability/runtime-telemetry.ts";
import { turnTokenEstimate } from "../core/loop.ts";
import { compactConversation } from "../service/compact.ts";
import { conversationMessages, recordFailedUsage } from "./shared.ts";
import type { AssembledPrompt, TurnBase } from "./types.ts";

export interface TurnPreflight {
  messages: ModelMessage[];
  estimatedPromptTokens: number;
  contextCap: number;
}

async function reserveBudget(
  base: TurnBase,
  estimated: number,
  estimatedPromptTokens: number,
): Promise<void> {
  const { p, route, seedModel } = base;
  const actor = actorFields(p.principal);
  try {
    await checkBudget(p.tenant_id, estimated, route.monthly_budget, p.db);
    const verdict = await checkAndDecrement(
      p.tenant_id,
      estimated,
      p.db,
      actor.actor_type === "user" ? actor.user_id : null,
    );
    if (!verdict.ok) {
      throw new LlmQuotaExhausted("llm_quota_exhausted", {
        used: verdict.used,
        projected_tokens: verdict.projected_tokens,
        budget: verdict.budget,
        remaining: verdict.remaining,
        scope: verdict.scope ?? "tenant",
      });
    }
  } catch (err) {
    if (err instanceof LlmQuotaExhausted) {
      await recordFailedUsage(p, actor, {
        model: seedModel,
        prompt_tokens: estimatedPromptTokens,
        result: "quota_exhausted",
        error: "llm_quota_exhausted",
      });
      recordLlmQuotaExhausted({ tenant_id: p.tenant_id });
    }
    throw err;
  }
}

export async function preflightTurn(
  base: TurnBase,
  prompt: AssembledPrompt,
): Promise<TurnPreflight> {
  const { p, route, seedModel, budget } = base;
  let messages = await timePhaseAsync("converse.build_model_messages", () =>
    conversationMessages(p),
  );
  let messageTokens = timePhase("converse.count_message_tokens", () =>
    countModelMessagesTokens(messages),
  );
  let { estimatedPromptTokens, estimated } = turnTokenEstimate(
    prompt.token_counts.total,
    messageTokens,
    budget,
  );

  const contextCap = contextCapFor(seedModel);
  recordConversationBudgetReport(p.tenant_id, p.conversation_id, {
    cap_tokens: Math.min(route.context_cap, contextCap),
    total_tokens: prompt.token_counts.total,
    dropped_sections: prompt.dropped_sections,
    assembled_at: new Date().toISOString(),
  });
  if (estimatedPromptTokens > contextCap) {
    const compaction = await compactConversation(
      {
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        actor_id: p.actor_id,
        ...(p.principal !== undefined ? { principal: p.principal } : {}),
      },
      p.db,
    );
    if (compaction.messages_collapsed > 0) {
      messages = await conversationMessages(p);
      messageTokens = countModelMessagesTokens(messages);
      const before = estimatedPromptTokens;
      ({ estimatedPromptTokens, estimated } = turnTokenEstimate(
        prompt.token_counts.total,
        messageTokens,
        budget,
      ));
      logger.warn({
        module: "conversation",
        action: "preflight.context_auto_compacted",
        msg: "assembled prompt exceeded the context cap; auto-compacted the conversation and retried",
        conversation_id: p.conversation_id,
        tenant_id: p.tenant_id,
        model: seedModel,
        messages_collapsed: compaction.messages_collapsed,
        estimated_prompt_tokens_before: before,
        estimated_prompt_tokens_after: estimatedPromptTokens,
        context_cap: contextCap,
      });
    }
    if (estimatedPromptTokens > contextCap) {
      logger.warn({
        module: "conversation",
        action: "preflight.context_too_large",
        msg: "rejecting turn before provider call — assembled prompt exceeds context cap even after compaction",
        conversation_id: p.conversation_id,
        tenant_id: p.tenant_id,
        model: seedModel,
        estimated_prompt_tokens: estimatedPromptTokens,
        context_cap: contextCap,
        message_tokens: messageTokens,
        prompt_breakdown: prompt.token_counts,
        compacted: compaction.messages_collapsed > 0,
      });
      throw new LlmContextTooLarge("llm_context_too_large", {
        estimated_prompt_tokens: estimatedPromptTokens,
        context_cap: contextCap,
        message_tokens: messageTokens,
        prompt_total: prompt.token_counts.total,
        model: seedModel,
        remediation: "compact_or_resume",
      });
    }
  }

  await reserveBudget(base, estimated, estimatedPromptTokens);
  return { messages, estimatedPromptTokens, contextCap };
}
