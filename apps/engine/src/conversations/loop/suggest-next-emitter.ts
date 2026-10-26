import { and, desc, eq } from "drizzle-orm";
import { getConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { conversationMessages } from "../../db/schema/index.ts";
import { stripFileSentinelsForDisplay } from "../../files/sentinel.ts";
import { AiSdkModel } from "../../llm/core/ai-sdk-model.ts";
import { resolveModelRoute } from "../../llm/core/invoke.ts";
import {
  detectConfiguredProvider,
  modelForProvider,
  ProviderMisconfiguredError,
} from "../../llm/core/model-init.ts";
import type { RecentMessage } from "../../llm/core/suggestion-prompt.ts";
import { isCatalogModelProvider } from "../../llm/model-catalog-view.ts";
import type { ModelRoute } from "../../llm/types.ts";
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
  db?: Db;
  client_suppress?: boolean;
  loaded_skills?: ReadonlyArray<LoadedSkillHint>;
  model_invoker?: SuggestNextModelInvoker;
  budget_guard?: () => Promise<boolean> | boolean;
}

const SUGGEST_MAX_OUTPUT_TOKENS = 30;
const SUGGEST_TEMPERATURE = 0.2;
const SUGGEST_HISTORY_TURNS = 8;

function suggestionForCapability(slug: string): string {
  const tail = slug
    .replace(/^[a-z_]+\./, "")
    .replace(/[._]/g, " ")
    .trim();
  if (slug.startsWith("connector.")) return `Set up a connector for ${tail || "this service"}`;
  if (slug.startsWith("vendor_recipe."))
    return `Add a verified recipe for ${tail || "this client"}`;
  if (slug.startsWith("workflow")) return "Build a workflow for that";
  return `Add support for ${tail || slug}`;
}

function capabilityGapSuggestion(events: ReadonlyArray<TurnEvent>): string | null {
  for (const ev of events) {
    if (ev.type !== "tool_result" || ev.tool !== "cannot_help") continue;
    const data = (
      ev.output as {
        data?: { abstained?: unknown; missing_capability?: unknown; suggest_alternative?: unknown };
      } | null
    )?.data;
    if (data?.abstained !== true) continue;
    if (typeof data.suggest_alternative === "string" && data.suggest_alternative.trim()) {
      return data.suggest_alternative.trim();
    }
    if (typeof data.missing_capability === "string" && data.missing_capability.trim()) {
      return suggestionForCapability(data.missing_capability.trim());
    }
  }
  return null;
}

export async function buildNextSuggestionFrame(
  params: EmitSuggestNextFrameParams,
): Promise<TurnEvent> {
  try {
    if (!params.client_suppress) {
      const gap = capabilityGapSuggestion(params.events);
      if (gap) return nextSuggestion({ suggestion: gap, reason: "capability-gap", kind: "text" });
    }
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
      model_invoker: params.model_invoker ?? suggestNextModelInvoker(params.db),
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
  const rows = rowsDesc.slice().reverse();
  return collectFromRows(rows, maxTurns, { tenant_id, conversation_id });
}

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
      if (r.role === "assistant" && !isBenignNoTextContent(r.content)) {
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

function isBenignNoTextContent(content: unknown): boolean {
  if (typeof content === "string") return true;
  if (Array.isArray(content)) return true;
  return typeof content === "object" && content !== null;
}

function extractRecentMessages(
  events: ReadonlyArray<TurnEvent>,
  maxTurns: number,
  ctx: { tenant_id: string; conversation_id: string },
): ExtractedHistory {
  const rows: Array<{ role: string; content: unknown }> = [];
  for (const ev of events) {
    if (ev.type !== "message") continue;
    rows.push({ role: ev.role, content: ev.content });
  }
  return collectFromRows(rows, maxTurns, ctx);
}

function extractText(content: unknown): string {
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
      if (p.type === "tool-call" || p.type === "tool_use" || p.type === "tool-input") {
        const name =
          typeof p.toolName === "string" ? p.toolName : typeof p.name === "string" ? p.name : null;
        if (name) toolNames.push(name);
      }
    }
    if (parts.length > 0) return parts.join("");
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

export function suggestionModelFor(
  route: Pick<ModelRoute, "provider" | "primary" | "tenant_id">,
  configured: string | null | undefined,
): string {
  if (!isCatalogModelProvider(route.provider)) return configured?.trim() || route.primary;
  return modelForProvider(route.provider, configured, "light", route.tenant_id) ?? route.primary;
}

function suggestNextModelInvoker(db: Db | undefined): SuggestNextModelInvoker {
  return async (call: SuggestNextModelInvocation): Promise<SuggestNextModelResult> => {
    if (detectConfiguredProvider({ tenantId: call.tenant_id }) === "mock") return { text: null };
    let model: AiSdkModel;
    try {
      const route = await resolveModelRoute(call.tenant_id, db);
      if (route.provider === "mock") return { text: null };
      const suggestionModel = suggestionModelFor(
        route,
        getConfig(call.tenant_id).llm.suggestion_model,
      );
      model = new AiSdkModel({
        ...(db ? { exec: db } : {}),
        tenantId: call.tenant_id,
        providerOverride: route.provider,
        defaultModel: suggestionModel,
        modelOverride: suggestionModel,
        fallback: {
          ...(db ? { exec: db } : {}),
          tenantId: call.tenant_id,
          providerOverride: route.fallback_provider,
          defaultModel: route.fallback,
          modelOverride: route.fallback,
        },
      });
    } catch (err) {
      return modelInitFailed(err);
    }

    let result: Awaited<ReturnType<AiSdkModel["generateText"]>>;
    try {
      result = await model.generateText(
        [{ role: "system", content: call.system }, ...call.messages],
        { temperature: SUGGEST_TEMPERATURE, maxOutputTokens: SUGGEST_MAX_OUTPUT_TOKENS },
      );
    } catch (err) {
      if (err instanceof ProviderMisconfiguredError) return modelInitFailed(err);
      throw err;
    }
    return {
      text: result.response || null,
      model: result.model_used,
      usage: result.usage,
    };
  };
}

function modelInitFailed(err: unknown): SuggestNextModelResult {
  logger.warn({
    module: "conversations",
    action: "suggest_next.model_init_failed",
    msg: "could not resolve suggestion model — emitting empty",
    error: err instanceof Error ? err.message : String(err),
  });
  return { text: null };
}
