// Service orchestrator for the next-message suggestion. The single
// `suggestNextMessage()` entry point is what `loop.ts` calls right
// after `message_stop` to produce the SSE `next_suggestion` frame.
//
// Pipeline:
//   1. Hard suppressors (early conversation, client opt-out)
//   2. Offer-parse fast path (deterministic, zero-token)
//   3. Model fallback (small model, ≤30 completion tokens, history-only)
//   4. Filter pass (claude-voice / meta / evaluative / etc. — see
//      suggest-next-filter.ts)
//   5. Wrap with reason tag for the SSE frame + observability
//
// Errors NEVER throw to the caller — they become `{ suggestion: null,
// reason: "error" }` so the parent turn always closes cleanly. This
// is a load-bearing invariant: the suggestion is a UX nicety on top
// of a real turn; it must never take the turn down.
//
// The model + budget surfaces are injected via the parameters
// instead of hard-coded calls so unit tests don't need to mount the
// LLM provider, and so commit 4 can wire the real engine `generateText`
// without restructuring this file.

import type { SubkitLlmMessage, SubkitLlmUsage } from "../llm/core/base-types.ts";
import { assembleSuggestionPrompt, type RecentMessage } from "../llm/core/suggestion-prompt.ts";
import { logger } from "../logging/logger.ts";
import { recordLlmTokens, recordSuggestNextOutcome } from "../observability/instrumentation.ts";
import { filterSuggestion } from "./suggest-next-filter.ts";
import { type LoadedSkillHint, type ParsedOffer, parseOffer } from "./suggest-next-offer-parse.ts";

/**
 * Outcome reasons carried on the SSE frame. These are stable wire
 * values — the sk-cli client and dashboards both pivot on them.
 */
export type SuggestNextReason =
  | "offer-detected"
  | "offer-skill"
  | "model"
  | "early-conversation"
  | "client-suppress"
  | "filtered"
  | "empty"
  | "budget-pressure"
  | "error";

export type SuggestNextKind = "text" | "slash";

export interface SuggestNextResult {
  suggestion: string | null;
  reason: SuggestNextReason;
  kind: SuggestNextKind | null;
}

export interface SuggestNextModelInvocation {
  system: string;
  messages: SubkitLlmMessage[];
}

export interface SuggestNextModelResult {
  text: string | null;
  usage?: SubkitLlmUsage;
  model?: string;
}

export type SuggestNextModelInvoker = (
  call: SuggestNextModelInvocation,
) => Promise<SuggestNextModelResult>;

/**
 * The budget guard is called BEFORE the model fallback. Offer-parse
 * hits do not consume tokens and therefore bypass this gate. A `false`
 * return collapses the result to `{ suggestion: null, reason:
 * "budget-pressure" }` — never an error.
 */
export type SuggestNextBudgetGuard = () => Promise<boolean> | boolean;

export interface SuggestNextParams {
  tenant_id: string;
  conversation_id: string;
  /** Most-recent-last conversation history, text-only. */
  recent_messages: ReadonlyArray<RecentMessage>;
  /** The full text of the most recent assistant message (used for offer-parse). */
  last_assistant_text: string;
  /** Skills loaded into this conversation; optional. Drives skill-aware fast path. */
  loaded_skills?: ReadonlyArray<LoadedSkillHint>;
  /** Client-side dismiss-N-times feedback flag — when true, skip generation. */
  client_suppress?: boolean;
  /** Budget pre-check; defaults to "always allow" when omitted (e.g. tests). */
  budget_guard?: SuggestNextBudgetGuard;
  /**
   * Required for the model fallback. When omitted (e.g. tests), a model
   * fallback miss returns `{ suggestion: null, reason: "empty" }` —
   * exercised in unit tests that only want to validate the offer-parse
   * pipeline.
   */
  model_invoker?: SuggestNextModelInvoker;
}

const MIN_HISTORY_FOR_MODEL_CALL = 2;

export async function suggestNextMessage(params: SuggestNextParams): Promise<SuggestNextResult> {
  if (params.client_suppress === true) {
    emitOutcome(params.tenant_id, "suppressed", null);
    return { suggestion: null, reason: "client-suppress", kind: null };
  }

  if (params.recent_messages.length < MIN_HISTORY_FOR_MODEL_CALL) {
    emitOutcome(params.tenant_id, "suppressed", null);
    return { suggestion: null, reason: "early-conversation", kind: null };
  }

  // 1. Offer-parse fast path — no tokens, no network.
  const offer = parseOffer({
    assistant_text: params.last_assistant_text,
    ...(params.loaded_skills ? { loaded_skills: params.loaded_skills } : {}),
  });
  if (offer) {
    return finalizeOfferResult(params, offer);
  }

  // 2. Budget guard — only the model path consumes tokens.
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

  // 3. Model fallback — only if a real invoker is wired.
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
