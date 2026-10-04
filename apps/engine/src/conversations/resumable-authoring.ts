import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { conversationMessages, conversations } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import type { ConversationStatus, DraftDocument } from "./types.ts";

export const RESUMABLE_AUTHORING_WINDOW_MS = 30 * 60 * 1000;

const NON_TERMINAL: ConversationStatus[] = ["active", "awaiting_input"];

const CANDIDATE_SCAN = 20;

export interface ResumableAuthoringMatch {
  conversation_id: string;
  matched_slug: string;
}

export interface ResumableAuthoringTarget {
  connector_id?: string;
  workflow_id?: string;
}

export const IDENTICAL_MESSAGE_MARKER = "(identical-opening-message)";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function extractSlugTokens(text: string): Set<string> {
  const out = new Set<string>();
  const matches = text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)+/g);
  if (matches) for (const m of matches) out.add(m);
  return out;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

function candidateSlugTokens(draft: unknown): Set<string> {
  const tokens = new Set<string>();
  if (draft && typeof draft === "object") {
    const doc = draft as DraftDocument;
    const wfSlug = doc.workflow?.slug;
    if (typeof wfSlug === "string" && wfSlug.length > 0) tokens.add(wfSlug);
    const wfName = doc.workflow?.name;
    if (typeof wfName === "string" && wfName.length > 0) {
      const s = slugify(wfName);
      if (s.length > 0) tokens.add(s);
    }
    const target = doc.summary?.active_target;
    if (target) {
      if (typeof target.slug === "string" && target.slug.length > 0) tokens.add(target.slug);
      if (typeof target.name === "string" && target.name.length > 0) {
        const s = slugify(target.name);
        if (s.length > 0) tokens.add(s);
      }
    }
  }
  return tokens;
}

function normalizeMessage(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export async function findResumableAuthoringConversation(
  tenant_id: string,
  owner_id: string,
  message_or_slug: string,
  db: Executor,
  target: ResumableAuthoringTarget = {},
): Promise<ResumableAuthoringMatch | null> {
  if (!owner_id) return null;
  const incoming = extractSlugTokens(message_or_slug);
  const hasExplicitTarget = Boolean(target.workflow_id || target.connector_id);
  if (incoming.size === 0 && !hasExplicitTarget) return null;
  const incomingNormalized = normalizeMessage(message_or_slug);

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
        ...(target.workflow_id ? [eq(conversations.target_workflow_id, target.workflow_id)] : []),
        ...(target.connector_id
          ? [eq(conversations.target_connector_id, target.connector_id)]
          : []),
      ),
    )
    .orderBy(desc(conversations.updated_at))
    .limit(CANDIDATE_SCAN);
  if (rows.length === 0) return null;

  if (hasExplicitTarget) {
    const row = rows[0];
    if (!row) return null;
    const matchedResource = target.workflow_id
      ? "(explicit-workflow-id)"
      : "(explicit-connector-id)";
    logger.info({
      module: "conversation",
      action: "resumed",
      tenant_id,
      owner_id,
      conversation_id: row.id,
      matched_slug: matchedResource,
    });
    return { conversation_id: row.id, matched_slug: matchedResource };
  }

  const ids = rows.map((r) => r.id);
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

  for (const row of rows) {
    let matched: string | null = null;
    const candidate = candidateSlugTokens(row.draft);
    for (const token of incoming) {
      if (candidate.has(token)) {
        matched = token;
        break;
      }
    }
    if (!matched) {
      const firstMessage = firstMessageByConversation.get(row.id) ?? "";
      if (incomingNormalized.length > 0 && normalizeMessage(firstMessage) === incomingNormalized) {
        matched = IDENTICAL_MESSAGE_MARKER;
      }
    }
    if (matched) {
      logger.info({
        module: "conversation",
        action: "resumed",
        tenant_id,
        owner_id,
        conversation_id: row.id,
        matched_slug: matched,
      });
      return { conversation_id: row.id, matched_slug: matched };
    }
  }
  return null;
}
