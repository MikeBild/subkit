import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db, Executor } from "../db/client.ts";
import { conversationMessages, conversations } from "../db/schema/index.ts";
import { resolveModelRoute } from "../llm/core/invoke.ts";
import { runSummarizeFlow } from "../llm/flows/summarize.ts";
import { logger } from "../logging/logger.ts";
import { stringifyConversationExcerpt, truncateExcerpt } from "./excerpt.ts";

export const CONVERSATION_TITLE_MAX = 50;

export function deriveConversationTitle(content: unknown): string | null {
  const text = stringifyConversationExcerpt(content);
  if (!text) return null;
  const title = truncateExcerpt(text, CONVERSATION_TITLE_MAX);
  return title.length > 0 ? title : null;
}

export async function ensureConversationTitle(
  exec: Executor,
  tenant_id: string,
  conversation_id: string,
  content: unknown,
): Promise<string | null> {
  const title = deriveConversationTitle(content);
  if (!title) return null;
  const [row] = await exec
    .update(conversations)
    .set({ title })
    .where(
      and(
        eq(conversations.tenant_id, tenant_id),
        eq(conversations.id, conversation_id),
        isNull(conversations.title),
      ),
    )
    .returning({ title: conversations.title });
  return row?.title ?? null;
}

export const TITLE_REFRESH_EVERY_TURNS = 5;
const TITLE_SOURCE_MESSAGES = 6;
const TITLE_SOURCE_CHARS = 300;
export const TITLE_WORDS_MAX = 8;

export function shouldRefreshTitle(turn_count: number, title_locked: boolean): boolean {
  if (title_locked) return false;
  return turn_count === 1 || turn_count % TITLE_REFRESH_EVERY_TURNS === 0;
}

export function titleFromSummary(raw: string): string | null {
  const line =
    raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const unquoted = line
    .replace(/^["'„“‚‘`]+|["'“”‘’`]+$/g, "")
    .replace(/[.!]+$/g, "")
    .trim();
  if (!unquoted) return null;
  const words = unquoted.split(/\s+/).slice(0, TITLE_WORDS_MAX).join(" ");
  const title = truncateExcerpt(words, CONVERSATION_TITLE_MAX);
  return title.length > 0 ? title : null;
}

export function buildTitlePrompt(turns: Array<{ role: string; text: string }>): string {
  const transcript = turns
    .map(
      (t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text.slice(0, TITLE_SOURCE_CHARS)}`,
    )
    .join("\n");
  return [
    "Write a 4-6 word title for this conversation, in the language the user writes in.",
    "Focus on the user's goal and what was actually built, run or answered.",
    "Use an imperative verb (Build, Run, Check, Repair, Explain, ...) and name the concrete object.",
    "No quotes, no period, no meta-commentary. Reply with the title only.",
    "",
    "Conversation:",
    transcript,
  ].join("\n");
}

export function titleSourceTurns(
  rows: Array<{ role: string; content: unknown }>,
): Array<{ role: string; text: string }> {
  return rows
    .map((row) => ({ role: row.role, text: stringifyConversationExcerpt(row.content) ?? "" }))
    .filter((turn) => turn.text.length > 0);
}

export async function refreshConversationTitle(
  tenant_id: string,
  conversation_id: string,
  exec: Db,
): Promise<string | null> {
  try {
    return await refreshConversationTitleInner(tenant_id, conversation_id, exec);
  } catch (err) {
    logger.warn({
      module: "conversation",
      action: "title.refresh_failed",
      tenant_id,
      conversation_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function refreshConversationTitleInner(
  tenant_id: string,
  conversation_id: string,
  exec: Db,
): Promise<string | null> {
  const route = await resolveModelRoute(tenant_id, exec);
  if (route.provider === "mock") return null;
  const rows = await exec
    .select({ role: conversationMessages.role, content: conversationMessages.content })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, tenant_id),
        eq(conversationMessages.conversation_id, conversation_id),
        inArray(conversationMessages.role, ["user", "assistant"]),
      ),
    )
    .orderBy(asc(conversationMessages.created_at))
    .limit(TITLE_SOURCE_MESSAGES);
  const turns = titleSourceTurns(rows);
  if (!turns.some((turn) => turn.role === "user")) return null;
  const result = await runSummarizeFlow({ tenant_id, prompt: buildTitlePrompt(turns) }, exec);
  const title = titleFromSummary(result.summary);
  if (!title) return null;
  const [row] = await exec
    .update(conversations)
    .set({ title })
    .where(
      and(
        eq(conversations.tenant_id, tenant_id),
        eq(conversations.id, conversation_id),
        eq(conversations.title_locked, false),
      ),
    )
    .returning({ title: conversations.title });
  return row?.title ?? null;
}
