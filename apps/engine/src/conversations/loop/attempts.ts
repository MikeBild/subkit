import type { ModelMessage } from "ai";
import { actorFields } from "../../llm/accounting/index.ts";
import {
  classifyProviderError,
  shouldFallBack,
  toLlmProviderError,
  usageResultOf,
} from "../../llm/provider-errors.ts";
import { logger } from "../../logging/index.ts";
import { isExpectedCancellation } from "../abort.ts";
import { fallsBack } from "../core/loop.ts";
import { inferReplyLocale } from "../handoff-summary.ts";
import { fallbackRetryActivity } from "../retry-activity.ts";
import { LlmTimeoutError, providerFailureNotice } from "../turn-failure.ts";
import { runAttempt } from "./attempt.ts";
import { resolveConversationAttemptRoutes } from "./attempt-route.ts";
import { appendSyntheticAssistant, recordFailedUsage } from "./shared.ts";
import type { TurnEnv, TurnState } from "./types.ts";

async function announceProviderFailure(env: TurnEnv, err: unknown): Promise<void> {
  const { p, signals } = env;
  if (signals.lastAssistantText || env.abort.signal.aborted) return;
  const text = providerFailureNotice(err, p.locale ?? inferReplyLocale(env.ingestedUserMessage));
  if (!text) return;
  try {
    await appendSyntheticAssistant(p, env.events, signals, text, "provider_failure_notice");
  } catch (noticeErr) {
    logger.warn({
      module: "conversation",
      action: "loop.provider_failure_notice_failed",
      conversation_id: p.conversation_id,
      error: noticeErr instanceof Error ? noticeErr.message : String(noticeErr),
    });
  }
}

function typedProviderError(err: unknown) {
  return classifyProviderError(err) === "other" || err instanceof LlmTimeoutError
    ? null
    : toLlmProviderError(err);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runFallback(
  env: TurnEnv,
  state: TurnState,
  model: string,
  provider: Parameters<typeof runAttempt>[3],
): Promise<void> {
  const { p, route } = env;
  try {
    await runAttempt(env, state, model, provider);
  } catch (fbErr) {
    if (isExpectedCancellation(fbErr, env.abort.signal)) {
      state.cancelled = true;
      return;
    }
    const fbMsg = errorMessage(fbErr);
    logger.warn({
      module: "llm",
      action: "converse.failed",
      msg: "streamText fallback error",
      conversation_id: p.conversation_id,
      model: route.fallback,
      error: fbMsg,
    });
    await recordFailedUsage(p, actorFields(p.principal), {
      model: route.fallback,
      prompt_tokens: env.estimatedPromptTokens,
      result: usageResultOf(fbErr),
      error: fbMsg,
    });
    const typedFallbackErr = typedProviderError(fbErr);
    await announceProviderFailure(env, typedFallbackErr ?? fbErr);
    throw typedFallbackErr ?? fbErr;
  }
}

export async function runTurnAttempts(
  env: TurnEnv,
  state: TurnState,
  messages: ModelMessage[],
): Promise<void> {
  const { p, route, seedModel } = env;
  const attempts = resolveConversationAttemptRoutes(route, seedModel);
  try {
    await runAttempt(env, state, attempts.primary.model, attempts.primary.provider, messages);
  } catch (primaryErr) {
    if (isExpectedCancellation(primaryErr, env.abort.signal)) {
      state.cancelled = true;
      return;
    }
    const providerKind = classifyProviderError(primaryErr);
    const providerErr =
      providerKind === "other" || primaryErr instanceof LlmTimeoutError
        ? null
        : toLlmProviderError(primaryErr);
    const msg = errorMessage(primaryErr);
    logger.warn({
      module: "llm",
      action: "converse.failed",
      msg: "streamText primary error",
      conversation_id: p.conversation_id,
      model: seedModel,
      kind: providerErr?.kind ?? providerKind,
      error: msg,
    });
    await recordFailedUsage(p, actorFields(p.principal), {
      model: seedModel,
      prompt_tokens: env.estimatedPromptTokens,
      result: usageResultOf(primaryErr),
      error: msg,
    });
    if (
      !providerErr ||
      !fallsBack({
        fallbackModel: route.fallback,
        seedModel,
        eligible: () => shouldFallBack(primaryErr, route.provider, route.fallback_provider),
      })
    ) {
      await announceProviderFailure(env, providerErr ?? primaryErr);
      throw providerErr ?? primaryErr;
    }
    logger.warn({
      module: "llm",
      action: "fallback.triggered",
      msg: "llm fallback engaged",
      flow: "converse",
      conversation_id: p.conversation_id,
      primary: seedModel,
      fallback: route.fallback,
      kind: providerErr.kind,
    });
    env.events.push(fallbackRetryActivity());
    await runFallback(env, state, attempts.fallback.model, attempts.fallback.provider);
  }
}
