// conversation_start idempotency — resume a mid-authoring conversation
// instead of spawning a duplicate.
//
// One user intent ("create workflow load-jira-issue-full-details") that
// gets re-issued (the client lost track, retried, or the user typed it
// twice) used to call createConversation unconditionally and fragment the
// authoring state across several conversations — the user could not tell
// which one held the result. This helper closes that gap: before creating,
// the start handler asks whether THIS principal already has a RECENT,
// NON-TERMINAL conversation authoring the SAME workflow slug, and if so
// resumes it.
//
// The match is deliberately TIGHT to avoid a false-positive resume
// attaching an intent to the wrong conversation:
//   - same principal (tenant_id + owner_id),
//   - non-terminal status only (active | awaiting_input — a committed or
//     abandoned conversation is never resumed; re-authoring after commit
//     legitimately starts fresh),
//   - inside a short recency window (RESUMABLE_AUTHORING_WINDOW_MS),
//   - the incoming message names an EXPLICIT kebab-case slug token
//     (two+ segments, e.g. `load-jira-issue-full-details`) that also
//     appears as the candidate's authored slug or in its opening message.
//     A bare natural-language phrase carries no slug token, so it never
//     resumes — it starts fresh, which is the safe default.
//
// No DB unique constraint: that would block legitimate re-authoring of the
// same slug. This is a soft, read-side dedup scoped to the live window.

import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { conversationMessages, conversations } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import type { ConversationStatus, DraftDocument } from "./types.ts";

/**
 * How far back a conversation still counts as "mid-authoring" for the
 * idempotency check. Short on purpose: a re-issued intent lands within
 * minutes (an authoring turn itself runs 68-160s), and a stale window
 * would resume a conversation the user has mentally moved on from.
 */
export const RESUMABLE_AUTHORING_WINDOW_MS = 30 * 60 * 1000;

/** Non-terminal statuses — the only ones a start may resume. */
const NON_TERMINAL: ConversationStatus[] = ["active", "awaiting_input"];

/** Cap on recent candidates scanned. Bounded so the pass stays cheap. */
const CANDIDATE_SCAN = 20;

export interface ResumableAuthoringMatch {
  conversation_id: string;
  /** The slug token that matched — logged so the resume is auditable. */
  matched_slug: string;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Extract explicit kebab-case slug tokens (two or more `-`-joined
 * segments) from free text. A single bare word is NOT a slug reference —
 * only a multi-segment kebab token counts, which is exactly how a user or
 * client names a workflow slug ("create workflow load-jira-issue-full-details").
 * Keeping this tight is what prevents a vague prompt from resuming an
 * unrelated conversation.
 */
export function extractSlugTokens(text: string): Set<string> {
  const out = new Set<string>();
  const matches = text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)+/g);
  if (matches) for (const m of matches) out.add(m);
  return out;
}

/** Read the plain text of a `conversation_messages.content` jsonb value. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

/**
 * The set of slug tokens a candidate conversation is authoring against,
 * assembled from cheap, already-loaded sources (no full draft hydration):
 *   - the draft's authored workflow slug / name,
 *   - the draft summary's active target slug,
 *   - the opening user message's explicit kebab tokens (the signal that is
 *     present immediately, before the first turn has populated the draft).
 */
function candidateSlugTokens(draft: unknown, firstMessage: string): Set<string> {
  const tokens = extractSlugTokens(firstMessage);
  if (draft && typeof draft === "object") {
    const doc = draft as DraftDocument;
    const wfSlug = doc.workflow?.slug;
    if (typeof wfSlug === "string" && wfSlug.length > 0) tokens.add(wfSlug);
    const wfName = doc.workflow?.name;
    if (typeof wfName === "string" && wfName.length > 0) {
      const s = slugify(wfName);
      if (s.length > 0) tokens.add(s);
    }
    const activeSlug = doc.summary?.active_target?.slug;
    if (typeof activeSlug === "string" && activeSlug.length > 0) tokens.add(activeSlug);
  }
  return tokens;
}

/**
 * Find a recent, non-terminal authoring conversation OWNED by this
 * principal that is already authoring the same workflow slug named in
 * `message_or_slug`. Returns the match (most-recent first) or `null` when
 * the message names no slug or nothing in the live window matches — in
 * which case the caller creates a fresh conversation as before.
 *
 * Tenant-scoped: every query is filtered by `tenant_id`, and results are
 * further scoped to `owner_id` so a resume can only ever attach to the
 * caller's own conversation.
 */
export async function findResumableAuthoringConversation(
  tenant_id: string,
  owner_id: string,
  message_or_slug: string,
  db: Executor,
): Promise<ResumableAuthoringMatch | null> {
  if (!owner_id) return null;
  const incoming = extractSlugTokens(message_or_slug);
  // No explicit slug token in the prompt → cannot tightly identify a
  // target, so never resume. Start fresh (the safe default).
  if (incoming.size === 0) return null;

  const cutoff = new Date(Date.now() - RESUMABLE_AUTHORING_WINDOW_MS);
  const rows = await db
    .select({
      id: conversations.id,
      draft: conversations.draft,
      updated_at: conversations.updated_at,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenant_id, tenant_id),
        eq(conversations.owner_id, owner_id),
        inArray(conversations.status, NON_TERMINAL),
        gte(conversations.updated_at, cutoff),
      ),
    )
    .orderBy(desc(conversations.updated_at))
    .limit(CANDIDATE_SCAN);
  if (rows.length === 0) return null;

  const ids = rows.map((r) => r.id);
  // Opening user message per candidate — fetched ascending so the first
  // row seen for each conversation is its earliest (the intent that
  // opened it).
  const messages = await db
    .select({
      conversation_id: conversationMessages.conversation_id,
      content: conversationMessages.content,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, tenant_id),
        inArray(conversationMessages.conversation_id, ids),
        eq(conversationMessages.role, "user"),
      ),
    )
    .orderBy(conversationMessages.created_at);
  const firstMessageByConversation = new Map<string, string>();
  for (const m of messages) {
    if (firstMessageByConversation.has(m.conversation_id)) continue;
    firstMessageByConversation.set(m.conversation_id, messageText(m.content));
  }

  // rows are already most-recent-first → the first match wins.
  for (const row of rows) {
    const candidate = candidateSlugTokens(row.draft, firstMessageByConversation.get(row.id) ?? "");
    for (const token of incoming) {
      if (candidate.has(token)) {
        logger.info({
          module: "conversation",
          action: "resumed",
          tenant_id,
          owner_id,
          conversation_id: row.id,
          matched_slug: token,
        });
        return { conversation_id: row.id, matched_slug: token };
      }
    }
  }
  return null;
}
