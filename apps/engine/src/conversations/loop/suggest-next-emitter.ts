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

import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { conversationMessages } from "../../db/schema/index.ts";
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
  /**
   * When provided, the emitter loads the last N persisted messages from
   * the conversation store instead of scanning the per-turn events
   * buffer. Production callers (loop.ts) pass this so the model
   * fallback's prompt actually has multi-turn history; unit tests omit
   * it and the events buffer is used as a fallback.
   */
  db?: Db;
  client_suppress?: boolean;
  loaded_skills?: ReadonlyArray<LoadedSkillHint>;
  /** Optional override for the model invoker (used by integration tests). */
  model_invoker?: SuggestNextModelInvoker;
  /** Optional budget guard (true = allow). Default: always allow. */
  budget_guard?: () => Promise<boolean> | boolean;
}

// Allow operators on non-Anthropic providers (Bedrock, OpenAI, local
// mock) to swap the suggestion model without a code change. When
// `SK_SUGGEST_MODEL` is unset we fall back to the Haiku-class default;
// the call still no-ops cleanly when the provider can't resolve the
// model.
const SUGGEST_MODEL_DEFAULT = process.env.SK_SUGGEST_MODEL ?? "claude-haiku-4-5";
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
    // Production path: pull the last 8 persisted messages from the
    // conversation store. The just-completed assistant message has
    // already been persisted by the loop before the emitter runs, so
    // this returns N user+assistant turns (not just the current one).
    // Tests omit `db` and the events-buffer fallback is used.
    const { recent, lastAssistantText } = params.db
      ? await loadPersistedHistory(
          params.db,
          params.tenant_id,
          params.conversation_id,
          SUGGEST_HISTORY_TURNS,
        )
      : extractRecentMessages(params.events, SUGGEST_HISTORY_TURNS, {
          tenant_id: params.tenant_id,
          conversation_id: params.conversation_id,
        });
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

/**
 * Production history loader: targeted single-query select against
 * `conversation_messages` for the most recent N user+assistant rows in
 * `created_at` order. Lighter than calling `getConversation` (which
 * also pulls tool calls + drafts + elicitations + resume summaries —
 * all irrelevant to suggestion generation).
 */
async function loadPersistedHistory(
  db: Db,
  tenant_id: string,
  conversation_id: string,
  maxTurns: number,
): Promise<ExtractedHistory> {
  const rows = await db
    .select({
      role: conversationMessages.role,
      content: conversationMessages.content,
      created_at: conversationMessages.created_at,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, tenant_id),
        eq(conversationMessages.conversation_id, conversation_id),
      ),
    )
    .orderBy(asc(conversationMessages.created_at));
  const collected: RecentMessage[] = [];
  let lastAssistantText = "";
  for (const r of rows) {
    if (r.role !== "user" && r.role !== "assistant") continue;
    const text = extractText(r.content);
    if (!text) {
      if (r.role === "assistant") {
        logger.warn({
          module: "conversations",
          action: "suggest_next.content_shape_unrecognized",
          msg: "assistant message had no extractable text — offer-parse will miss",
          tenant_id,
          conversation_id,
          content_kind: typeof r.content,
        });
      }
      continue;
    }
    collected.push({ role: r.role, text });
    if (r.role === "assistant") lastAssistantText = text;
  }
  const recent = collected.slice(-maxTurns);
  return { recent, lastAssistantText };
}

function extractRecentMessages(
  events: ReadonlyArray<TurnEvent>,
  maxTurns: number,
  ctx: { tenant_id: string; conversation_id: string },
): ExtractedHistory {
  const collected: RecentMessage[] = [];
  let lastAssistantText = "";
  for (const ev of events) {
    if (ev.type !== "message") continue;
    if (ev.role !== "user" && ev.role !== "assistant") continue;
    const text = extractText(ev.content);
    if (!text) {
      // Warn (don't fail) when an assistant message comes through with
      // a content shape extractText doesn't understand. Today the
      // contract is the `{ text, _violations? }` payload built in
      // `loop.ts:1128`; future variants (multi-part content, tool-only
      // turns) would silently degrade the offer-parse to a model
      // fallback. The warning makes that visible.
      if (ev.role === "assistant") {
        logger.warn({
          module: "conversations",
          action: "suggest_next.content_shape_unrecognized",
          msg: "assistant message had no extractable text — offer-parse will miss",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          content_kind: typeof ev.content,
        });
      }
      continue;
    }
    collected.push({ role: ev.role, text });
    if (ev.role === "assistant") lastAssistantText = text;
  }
  const recent = collected.slice(-maxTurns);
  return { recent, lastAssistantText };
}

/**
 * Pulls the human-readable text out of the loop's persisted message
 * `content` shape. Today that's either a plain string (legacy /
 * synthetic frames) or the `{ text, _violations? }` payload built in
 * `loop.ts:1128`. The contract is intentionally narrow — adding a
 * new shape requires updating this function AND the
 * `suggest_next.content_shape_unrecognized` warning so a silent
 * regression stays loud.
 */
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

  // SubkitLlmMessage and ai-sdk's `ModelMessage` are structurally
  // compatible — both `{ role, content }` with the same role enum
  // and a string-or-parts content. The cast goes through `unknown`
  // to satisfy the no-any rule while documenting the boundary.
  // `resolved.model` is typed as the engine's wrapper-friendly
  // `LanguageModel | string` union; here we only land in this branch
  // when `provider !== "mock"`, so it is always the real
  // `LanguageModel`.
  const messages = call.messages as unknown as ModelMessage[];
  const model = resolved.model as unknown as LanguageModel;
  const result = await generateText({
    model,
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
