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

import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { conversations } from "../db/schema/index.ts";
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
