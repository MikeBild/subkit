// A conversation names itself from its first request.
//
// `conversations.title` was nullable and written in only three places, none of
// which is a path a person actually uses: create-with-explicit-title, an
// explicit PATCH, and fork. The two highest-volume creators — the chat
// dispatcher and the MCP capability — never passed one, so practically every
// row was untitled and every list rendered the same fallback word.
//
// The derivation is deterministic on purpose. An LLM summary would need a queue
// job, a token budget, a retry policy and an eval fixture to render one list
// row; the first user message already carries what the person came to do. A
// later `summary` column can layer on top with `summary || title || fallback`
// precedence without reworking any of this.
//
// It runs INSIDE `appendMessage`, after the secret scrub — deriving earlier
// would let a pasted credential become a conversation title.

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db, Executor } from "../db/client.ts";
import { conversationMessages, conversations } from "../db/schema/index.ts";
import { resolveModelRoute } from "../llm/core/invoke.ts";
import { runSummarizeFlow } from "../llm/flows/summarize.ts";
import { logger } from "../logging/logger.ts";
import { stringifyConversationExcerpt, truncateExcerpt } from "./excerpt.ts";

/** Titles are read in a narrow sidebar; longer than this is not a title. */
export const CONVERSATION_TITLE_MAX = 50;

/** Reduce a persisted user message to a title, or null when it carries none. */
export function deriveConversationTitle(content: unknown): string | null {
  const text = stringifyConversationExcerpt(content);
  if (!text) return null;
  const title = truncateExcerpt(text, CONVERSATION_TITLE_MAX);
  return title.length > 0 ? title : null;
}

/**
 * Give a conversation a title if it has none.
 *
 * The `title IS NULL` guard makes this idempotent by construction: a title set
 * by an operator's PATCH, by an explicit create, or by an earlier message is
 * never overwritten, so the second user message cannot rename the session out
 * from under whoever named it.
 *
 * Returns the title the row carries afterwards, or null when nothing was
 * derivable — callers that must report the row they just created use this
 * instead of re-reading.
 */
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

/** After which turns the automatic titler runs: once the first answer is
 *  in, then every fifth exchange, so a title tracks where the conversation
 *  actually went instead of freezing on the opening line. */
export const TITLE_REFRESH_EVERY_TURNS = 5;
/** How much of the transcript the titler reads — the opening exchange is
 *  what names a conversation; later turns rarely change its goal. */
const TITLE_SOURCE_MESSAGES = 6;
const TITLE_SOURCE_CHARS = 300;
export const TITLE_WORDS_MAX = 8;

export function shouldRefreshTitle(turn_count: number, title_locked: boolean): boolean {
  if (title_locked) return false;
  return turn_count === 1 || turn_count % TITLE_REFRESH_EVERY_TURNS === 0;
}

/** The model's line, made into a title: one line, no wrapping quotes, no
 *  trailing period, at most `TITLE_WORDS_MAX` words, within the column width. */
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

/**
 * Re-title a conversation from its opening exchange. Best effort and quiet:
 * a failure logs and leaves the row as it was. Skips locked titles (a
 * person named it) and the mock provider (tests would otherwise burn a
 * model call per turn and read canned text as a title).
 */
export async function refreshConversationTitle(
  tenant_id: string,
  conversation_id: string,
  exec: Db,
): Promise<string | null> {
  // Runs off the response path (`void` at the call site), so nothing here may
  // reject: a pool closed under it — the test harness tearing down right
  // after a turn — must end as a log line, not an unhandled rejection.
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
  const turns = rows
    .map((r) => ({ role: r.role, text: stringifyConversationExcerpt(r.content) ?? "" }))
    .filter((t) => t.text.length > 0);
  if (turns.length < 2 || !turns.some((t) => t.role === "assistant")) return null;
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
