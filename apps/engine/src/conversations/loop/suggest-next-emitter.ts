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
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { conversationMessages } from "../../db/schema/index.ts";
import { stripFileSentinelsForDisplay } from "../../files/sentinel.ts";
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
  /**
   * Skill hints that drive the offer-skill slash variant of offer-parse.
   * Production loop.ts does NOT pass this today — Skill records carry
   * slugs but no `verbs[]` field, so resolving an offered action to a
   * slash invocation isn't possible yet. Unit tests use this seam
   * directly to validate the offer-skill code path.
   */
  loaded_skills?: ReadonlyArray<LoadedSkillHint>;
  /** Optional override for the model invoker (used by integration tests). */
  model_invoker?: SuggestNextModelInvoker;
  /** Optional budget guard (true = allow). Default: always allow. */
  budget_guard?: () => Promise<boolean> | boolean;
}

// Allow operators on non-Anthropic providers (Bedrock, OpenAI, local
// mock) to swap the suggestion model without a code change. The
// `SK_SUGGEST_MODEL` env override is read PER-REQUEST inside
// `defaultSuggestNextModelInvoker` (matching `web-search.ts`'s
// `TAVILY_API_KEY` precedent), not at module load — that way an
// operator can `export SK_SUGGEST_MODEL=...` mid-process and the next
// turn picks it up. Promoting this to a `llm.suggestion.model` config
// knob is tracked as a follow-up; until the suggestion feature has
// wider operator demand the env override is the lighter surface.
const SUGGEST_MODEL_FALLBACK = "claude-haiku-4-5";
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
 * `conversation_messages` for the most recent N user+assistant rows.
 * Lighter than calling `getConversation` (which also pulls tool calls
 * + drafts + elicitations + resume summaries — all irrelevant to
 * suggestion generation) AND bounded — `ORDER BY desc LIMIT (maxTurns
 * * 3)` keeps the query constant-time even on a 10k-message
 * conversation. The `* 3` factor accommodates tool / system rows that
 * get filtered out of the user/assistant pair we actually want.
 */
async function loadPersistedHistory(
  db: Db,
  tenant_id: string,
  conversation_id: string,
  maxTurns: number,
): Promise<ExtractedHistory> {
  const rowsDesc = await db
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
    .orderBy(desc(conversationMessages.created_at))
    .limit(maxTurns * 3);
  // Reverse in-memory so the caller sees oldest-first, matching the
  // events-buffer fallback path's ordering contract.
  const rows = rowsDesc.slice().reverse();
  return collectFromRows(rows, maxTurns, { tenant_id, conversation_id });
}

/**
 * Shared collector: filters user/assistant rows, runs the content
 * shape extractor, warns on assistant rows that yield no text, and
 * returns the trailing N. Used by both the production
 * (`loadPersistedHistory`) and the unit-test (`extractRecentMessages`)
 * paths so they cannot drift.
 */
function collectFromRows(
  rows: ReadonlyArray<{ role: string; content: unknown }>,
  maxTurns: number,
  ctx: { tenant_id: string; conversation_id: string },
): ExtractedHistory {
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
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
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
  // Project events to the `{ role, content }` shape `collectFromRows`
  // expects; this keeps both history-loaders going through the same
  // extractor so the content-shape contract has one home.
  const rows: Array<{ role: string; content: unknown }> = [];
  for (const ev of events) {
    if (ev.type !== "message") continue;
    rows.push({ role: ev.role, content: ev.content });
  }
  return collectFromRows(rows, maxTurns, ctx);
}

/**
 * Pulls the human-readable text out of the loop's persisted message
 * `content` shape. Today there are three known shapes:
 *
 *   1. plain string                              — legacy / synthetic frames
 *   2. `{ text, _violations? }`                  — loop.ts:1128
 *   3. AI SDK 6 multi-part content array         — assistant turns where
 *      `{ role: "assistant", content: [{ type: "text", text: ... },
 *                                       { type: "tool_use", ... }, ...] }`
 *      is the natural shape. Session 0498925e fired
 *      `suggest_next.content_shape_unrecognized` 16× because the
 *      previous extractor only handled (1) and (2) and silently
 *      dropped the array — the next-suggestion chip never populated
 *      on turns that emitted a tool_use. Polish B flattens the array
 *      and concatenates every `{ type: "text", text }` part so the
 *      offer-parser sees the visible assistant prose.
 *
 * The contract is intentionally narrow — adding a new shape requires
 * updating this function AND keeping the
 * `suggest_next.content_shape_unrecognized` warning live so a silent
 * regression stays loud.
 */
function extractText(content: unknown): string {
  // Strip `[file:fid_<uuid>]` sentinels before the suggestion prompt
  // sees the text. The suggestion model never re-resolves file refs
  // through `buildUserContentParts` (the prompt is intentionally
  // minimal, no DB-roundtrip allowed — see the design note below); a
  // literal sentinel in the prompt would either confuse the model or
  // leak the raw fid into the suggestion preview text.
  const raw = extractTextRaw(content);
  return stripFileSentinelsForDisplay(raw);
}

function extractTextRaw(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    const toolNames: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as { type?: unknown; text?: unknown; toolName?: unknown; name?: unknown };
      if (p.type === "text" && typeof p.text === "string") {
        parts.push(p.text);
        continue;
      }
      // AI SDK 6 tool-use parts surface either `toolName` (input-streaming
      // shape) or `name` (call shape). Capture both — they're equivalent
      // for the synthetic-summary use case.
      if (p.type === "tool-call" || p.type === "tool_use" || p.type === "tool-input") {
        const name =
          typeof p.toolName === "string" ? p.toolName : typeof p.name === "string" ? p.name : null;
        if (name) toolNames.push(name);
      }
    }
    if (parts.length > 0) return parts.join("");
    // Tool-only assistant turn: surface a synthetic summary so the
    // offer-parser / suggest-next has something to read AND the
    // `content_shape_unrecognized` warn does not fire for what is
    // structurally a valid turn. Production traffic showed 348× this
    // warn over a 7-day window — every one was a tool-only turn.
    if (toolNames.length > 0) {
      const unique = Array.from(new Set(toolNames)).slice(0, 3);
      return `(called ${unique.join(", ")})`;
    }
    return "";
  }
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
 *
 * Design note: do NOT route this through `core/invoke.ts` /
 * `assembleContext`. That path pulls in skills, knowledge, docs,
 * runtime context, and a full system prompt — exactly the wiring the
 * `suggestion-prompt.ts` assembler is designed to avoid. Re-routing
 * would re-introduce the 1M-token empty-turn class of bug we already
 * fought once. The structural casts on `messages` / `model` below
 * (lines through `unknown` to `ModelMessage` / `LanguageModel`) are
 * load-bearing here: they bridge the engine's `SubkitLlmMessage`
 * shape to the AI SDK's `ModelMessage` without a runtime adapter.
 */
const defaultSuggestNextModelInvoker: SuggestNextModelInvoker = async (
  call: SuggestNextModelInvocation,
): Promise<SuggestNextModelResult> => {
  let resolved: Awaited<ReturnType<typeof initializeModel>>;
  try {
    // Per-request env read (see SUGGEST_MODEL_FALLBACK comment).
    const modelId = process.env.SK_SUGGEST_MODEL ?? SUGGEST_MODEL_FALLBACK;
    resolved = await initializeModel({ defaultModel: modelId });
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
