import type { SubkitLlmMessage, SubkitLlmUsage } from "../llm/runtime/base-types.ts";
import { assembleSuggestionPrompt, type RecentMessage } from "../llm/runtime/suggestion-prompt.ts";
import { logger } from "../logging/logger.ts";
import { recordLlmTokens, recordSuggestNextOutcome } from "../observability/instrumentation.ts";
import { filterSuggestion } from "./suggest-next-filter.ts";
import { type LoadedSkillHint, type ParsedOffer, parseOffer } from "./suggest-next-offer-parse.ts";

export type { SuggestNextKind, SuggestNextReason } from "@shared/suggest-next-reasons.ts";

import type { SuggestNextKind, SuggestNextReason } from "@shared/suggest-next-reasons.ts";

interface SuggestNextResult {
  suggestion: string | null;
  reason: SuggestNextReason;
  kind: SuggestNextKind | null;
}

export interface SuggestNextModelInvocation {
  system: string;
  messages: SubkitLlmMessage[];
  tenant_id: string;
}

export interface SuggestNextModelResult {
  text: string | null;
  usage?: SubkitLlmUsage;
  model?: string;
}

export type SuggestNextModelInvoker = (
  call: SuggestNextModelInvocation,
) => Promise<SuggestNextModelResult>;

type SuggestNextBudgetGuard = () => Promise<boolean> | boolean;

interface SuggestNextParams {
  tenant_id: string;
  conversation_id: string;
  recent_messages: ReadonlyArray<RecentMessage>;
  last_assistant_text: string;
  loaded_skills?: ReadonlyArray<LoadedSkillHint>;
  client_suppress?: boolean;
  budget_guard?: SuggestNextBudgetGuard;
  model_invoker?: SuggestNextModelInvoker;
}

const MIN_HISTORY_FOR_MODEL_CALL = 2;

function endsWithCtaQuestion(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith("?")) return false;
  const lastBoundary = Math.max(
    trimmed.lastIndexOf(". "),
    trimmed.lastIndexOf("\n"),
    trimmed.lastIndexOf("! "),
    trimmed.lastIndexOf("? ", trimmed.length - 2),
  );
  const lastSentence = (lastBoundary >= 0 ? trimmed.slice(lastBoundary + 1) : trimmed).trim();
  if (lastSentence.length === 0) return false;
  if (lastSentence.length > 280) return false;
  return true;
}

export async function suggestNextMessage(params: SuggestNextParams): Promise<SuggestNextResult> {
  if (params.client_suppress === true) {
    emitOutcome(params.tenant_id, "suppressed", null);
    return { suggestion: null, reason: "client-suppress", kind: null };
  }

  if (params.recent_messages.length < MIN_HISTORY_FOR_MODEL_CALL) {
    emitOutcome(params.tenant_id, "suppressed", null);
    return { suggestion: null, reason: "early-conversation", kind: null };
  }

  const offer = parseOffer({
    assistant_text: params.last_assistant_text,
    ...(params.loaded_skills ? { loaded_skills: params.loaded_skills } : {}),
  });
  if (offer) {
    return finalizeOfferResult(params, offer);
  }

  if (endsWithCtaQuestion(params.last_assistant_text)) {
    logger.info({
      module: "conversations",
      action: "suggest_next.suppressed",
      msg: "next-message suggestion suppressed (assistant ended with CTA question)",
      tenant_id: params.tenant_id,
      conversation_id: params.conversation_id,
      reason: "assistant-cta-question",
    });
    emitOutcome(params.tenant_id, "suppressed", null);
    return { suggestion: null, reason: "filtered", kind: null };
  }

  if (params.budget_guard) {
    let ok = true;
    try {
      ok = await Promise.resolve(params.budget_guard());
    } catch (err) {
      logSuggestError(params, "budget_guard_threw", err);
      emitOutcome(params.tenant_id, "error", null);
      return { suggestion: null, reason: "error", kind: null };
    }
    if (!ok) {
      logger.info({
        module: "conversations",
        action: "suggest_next.suppressed",
        msg: "next-message suggestion suppressed (budget pressure)",
        tenant_id: params.tenant_id,
        conversation_id: params.conversation_id,
        reason: "budget-pressure",
      });
      emitOutcome(params.tenant_id, "budget_pressure", null);
      return { suggestion: null, reason: "budget-pressure", kind: null };
    }
  }

  if (!params.model_invoker) {
    emitOutcome(params.tenant_id, "suppressed", null);
    return { suggestion: null, reason: "empty", kind: null };
  }

  const prompt = assembleSuggestionPrompt({
    recent_messages: params.recent_messages,
  });

  let modelResult: SuggestNextModelResult;
  try {
    modelResult = await params.model_invoker({
      system: prompt.system,
      messages: prompt.messages,
      tenant_id: params.tenant_id,
    });
  } catch (err) {
    logSuggestError(params, "model_invoker_threw", err);
    emitOutcome(params.tenant_id, "error", null);
    return { suggestion: null, reason: "error", kind: null };
  }

  if (modelResult.usage && modelResult.model) {
    recordLlmTokens({
      tenant_id: params.tenant_id,
      model: modelResult.model,
      flow: "suggest_next",
      prompt_tokens: modelResult.usage.input_tokens ?? 0,
      completion_tokens: modelResult.usage.output_tokens ?? 0,
    });
  }

  const raw = (modelResult.text ?? "").trim();
  if (raw.length === 0) {
    logger.info({
      module: "conversations",
      action: "suggest_next.generated",
      msg: "next-message suggestion empty",
      tenant_id: params.tenant_id,
      conversation_id: params.conversation_id,
      reason: "empty",
      length: 0,
    });
    emitOutcome(params.tenant_id, "suppressed", null);
    return { suggestion: null, reason: "empty", kind: null };
  }

  const filterReason = filterSuggestion(raw);
  if (filterReason !== null) {
    logger.info({
      module: "conversations",
      action: "suggest_next.filtered",
      msg: "next-message suggestion filtered",
      tenant_id: params.tenant_id,
      conversation_id: params.conversation_id,
      filter_reason: filterReason,
      length: raw.length,
    });
    emitOutcome(params.tenant_id, "suppressed", null);
    return { suggestion: null, reason: "filtered", kind: null };
  }

  const kind: SuggestNextKind = raw.startsWith("/") ? "slash" : "text";
  logger.info({
    module: "conversations",
    action: "suggest_next.generated",
    msg: "next-message suggestion generated",
    tenant_id: params.tenant_id,
    conversation_id: params.conversation_id,
    reason: "model",
    kind,
    length: raw.length,
  });
  emitOutcome(params.tenant_id, "generated", kind);
  return { suggestion: raw, reason: "model", kind };
}

function finalizeOfferResult(params: SuggestNextParams, offer: ParsedOffer): SuggestNextResult {
  const filterReason = filterSuggestion(offer.suggestion);
  if (filterReason !== null) {
    logger.info({
      module: "conversations",
      action: "suggest_next.filtered",
      msg: "next-message suggestion filtered (offer-parse path)",
      tenant_id: params.tenant_id,
      conversation_id: params.conversation_id,
      filter_reason: filterReason,
      length: offer.suggestion.length,
    });
    emitOutcome(params.tenant_id, "suppressed", null);
    return { suggestion: null, reason: "filtered", kind: null };
  }
  logger.info({
    module: "conversations",
    action: "suggest_next.generated",
    msg: "next-message suggestion generated (offer-parse path)",
    tenant_id: params.tenant_id,
    conversation_id: params.conversation_id,
    reason: offer.reason,
    kind: offer.kind,
    length: offer.suggestion.length,
  });
  emitOutcome(params.tenant_id, "generated", offer.kind);
  return {
    suggestion: offer.suggestion,
    reason: offer.reason,
    kind: offer.kind,
  };
}

function emitOutcome(
  tenant_id: string,
  outcome: Parameters<typeof recordSuggestNextOutcome>[0]["outcome"],
  kind: SuggestNextKind | null,
): void {
  recordSuggestNextOutcome({
    tenant_id,
    outcome,
    ...(kind ? { kind } : {}),
  });
}

function logSuggestError(params: SuggestNextParams, action: string, err: unknown): void {
  logger.warn({
    module: "conversations",
    action: `suggest_next.${action}`,
    msg: "next-message suggestion threw — turn unaffected",
    tenant_id: params.tenant_id,
    conversation_id: params.conversation_id,
    error: err instanceof Error ? err.message : String(err),
  });
}
