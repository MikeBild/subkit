// Glue between the turn loop and the next-message suggestion service.
// Lives outside loop.ts because the loop is already 1700+ LOC and the
// only thing this helper needs is a finished events array — no
// turn-loop internals.
//
// Contract:
//   - Called exactly once per turn, AFTER `events.push({ type:
//     "completed", ... })` and BEFORE the SSE outcome envelope.
//   - Builds the suggestion-service params from the buffered events
//     plus a default Anthropic-Haiku model invoker.
//   - Returns the `next_suggestion` TurnEvent for the loop to push.
//   - NEVER throws — a swallowed failure becomes `{ suggestion: null,
//     reason: "error" }` so the parent turn always closes cleanly.

import { generateText } from "ai";
import { initializeModel } from "../../llm/core/model-init.ts";
import type { RecentMessage } from "../../llm/core/suggestion-prompt.ts";
import { logger } from "../../logging/logger.ts";
import { nextSuggestion } from "../streaming.ts";
import {
  type SuggestNextModelInvocation,
  type SuggestNextModelInvoker,
  type SuggestNextModelResult,
  suggestNextMessage,
} from "../suggest-next.ts";
import type { LoadedSkillHint } from "../suggest-next-offer-parse.ts";
import type { TurnEvent } from "../types.ts";

export interface EmitSuggestNextFrameParams {
  tenant_id: string;
  conversation_id: string;
  events: ReadonlyArray<TurnEvent>;
  client_suppress?: boolean;
  loaded_skills?: ReadonlyArray<LoadedSkillHint>;
  /** Optional override for the model invoker (used by integration tests). */
  model_invoker?: SuggestNextModelInvoker;
  /** Optional budget guard (true = allow). Default: always allow. */
  budget_guard?: () => Promise<boolean> | boolean;
}

const SUGGEST_MODEL_DEFAULT = "claude-haiku-4-5";
const SUGGEST_MAX_OUTPUT_TOKENS = 30;
const SUGGEST_TEMPERATURE = 0.2;
const SUGGEST_HISTORY_TURNS = 8;

/**
 * Build the next_suggestion frame for the buffered events array.
 * Always returns a frame — `suggestion: null` plus a reason tag when
 * the suggestion is suppressed, filtered, or generation failed.
 */
export async function buildNextSuggestionFrame(
  params: EmitSuggestNextFrameParams,
): Promise<TurnEvent> {
  try {
    const { recent, lastAssistantText } = extractRecentMessages(
      params.events,
      SUGGEST_HISTORY_TURNS,
    );
    const callParams: Parameters<typeof suggestNextMessage>[0] = {
      tenant_id: params.tenant_id,
      conversation_id: params.conversation_id,
      recent_messages: recent,
      last_assistant_text: lastAssistantText,
      model_invoker: params.model_invoker ?? defaultSuggestNextModelInvoker,
    };
    if (params.client_suppress !== undefined) callParams.client_suppress = params.client_suppress;
    if (params.loaded_skills) callParams.loaded_skills = params.loaded_skills;
    if (params.budget_guard) callParams.budget_guard = params.budget_guard;

    const result = await suggestNextMessage(callParams);
    return nextSuggestion({
      suggestion: result.suggestion,
      reason: result.reason,
      kind: result.kind,
    });
  } catch (err) {
    logger.warn({
      module: "conversations",
      action: "suggest_next.emitter_threw",
      msg: "suggestion emitter threw — emitting null frame",
      tenant_id: params.tenant_id,
      conversation_id: params.conversation_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return nextSuggestion({ suggestion: null, reason: "error", kind: null });
  }
}

interface ExtractedHistory {
  recent: RecentMessage[];
  lastAssistantText: string;
}

function extractRecentMessages(
  events: ReadonlyArray<TurnEvent>,
  maxTurns: number,
): ExtractedHistory {
  const collected: RecentMessage[] = [];
  let lastAssistantText = "";
  for (const ev of events) {
    if (ev.type !== "message") continue;
    if (ev.role !== "user" && ev.role !== "assistant") continue;
    const text = extractText(ev.content);
    if (!text) continue;
    collected.push({ role: ev.role, text });
    if (ev.role === "assistant") lastAssistantText = text;
  }
  const recent = collected.slice(-maxTurns);
  return { recent, lastAssistantText };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && "text" in content) {
    const t = (content as { text?: unknown }).text;
    return typeof t === "string" ? t : "";
  }
  return "";
}

/**
 * Default model invoker — direct AI SDK call with a small Haiku-class
 * model and a 30-token output cap. Bypasses the heavy AiSdkModel
 * wrapper because suggestion generation never needs fallback,
 * tool-loop iteration, or context assembly. Provider misconfiguration
 * collapses to `text: null` so the suggestion service emits
 * `reason: "empty"` and the turn closes cleanly.
 */
const defaultSuggestNextModelInvoker: SuggestNextModelInvoker = async (
  call: SuggestNextModelInvocation,
): Promise<SuggestNextModelResult> => {
  let resolved: Awaited<ReturnType<typeof initializeModel>>;
  try {
    resolved = await initializeModel({ defaultModel: SUGGEST_MODEL_DEFAULT });
  } catch (err) {
    logger.warn({
      module: "conversations",
      action: "suggest_next.model_init_failed",
      msg: "could not resolve suggestion model — emitting empty",
      error: err instanceof Error ? err.message : String(err),
    });
    return { text: null };
  }
  if (resolved.provider === "mock") return { text: null };

  // biome-ignore lint/suspicious/noExplicitAny: ai-sdk message shape mirrors SubkitLlmMessage.
  const messages = call.messages as any;
  const result = await generateText({
    // biome-ignore lint/suspicious/noExplicitAny: LanguageModel typing differs across SDK majors.
    model: resolved.model as any,
    system: call.system,
    messages,
    maxOutputTokens: SUGGEST_MAX_OUTPUT_TOKENS,
    temperature: SUGGEST_TEMPERATURE,
  });
  return {
    text: result.text ?? null,
    model: resolved.modelId,
    usage: {
      input_tokens: Number(result.usage?.inputTokens ?? 0),
      output_tokens: Number(result.usage?.outputTokens ?? 0),
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
  };
};
