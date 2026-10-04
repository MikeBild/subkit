import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { stringifyConversationExcerpt } from "../conversations/excerpt.ts";
import {
  CONVERSATION_TITLE_MAX,
  deriveConversationTitle,
  refreshConversationTitle,
} from "../conversations/title.ts";
import type { Db } from "../db/client.ts";
import { conversationMessages, conversations, dataMigrations } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";

export const CONVERSATION_TITLE_SWEEP_NAME = "conversation_title_model_v4";

const SCAN = 100;

const RETITLE = 10;

export interface ConversationTitleSweepDependencies {
  refreshTitle?: typeof refreshConversationTitle;
}

export function isStillOpeningLine(storedTitle: string | null, firstUserMessage: unknown): boolean {
  if (!storedTitle) return false;
  const derived = deriveConversationTitle(firstUserMessage);
  if (derived !== null && derived === storedTitle) return true;
  const text = stringifyConversationExcerpt(firstUserMessage);
  if (!text) return false;
  const squashed = text.replace(/\s+/g, " ").trim();
  if (squashed.length <= CONVERSATION_TITLE_MAX) return false;
  return `${squashed.slice(0, CONVERSATION_TITLE_MAX - 1).trimEnd()}…` === storedTitle;
}

export interface ConversationTitleSweepReport {
  done: boolean;
  scanned: number;
  retitled: number;
}

let cursor: { updated_at: string; id: string } | null = null;

export function resetConversationTitleSweep(): void {
  cursor = null;
}

export async function runConversationTitleSweep(
  db: Db,
  dependencies: ConversationTitleSweepDependencies = {},
): Promise<ConversationTitleSweepReport> {
  const marker = await db
    .select({ name: dataMigrations.name })
    .from(dataMigrations) // tenant-filter:exempt — instance-global sweep ledger
    .where(eq(dataMigrations.name, CONVERSATION_TITLE_SWEEP_NAME))
    .limit(1);
  if (marker.length > 0) return { done: true, scanned: 0, retitled: 0 };

  const started = Date.now();
  const conds = [isNotNull(conversations.title), eq(conversations.title_locked, false)];
  if (cursor) {
    conds.push(
      sql`(${conversations.updated_at}, ${conversations.id}) < (${cursor.updated_at}::timestamptz, ${cursor.id}::uuid)`,
    );
  }

  const batch = await db
    .select({
      id: conversations.id,
      tenant_id: conversations.tenant_id,
      title: conversations.title,
      updated_at: sql<string>`${conversations.updated_at}::text`,
    })
    .from(conversations) // tenant-filter:exempt — instance-wide maintenance sweep
    .where(and(...conds))
    .orderBy(desc(conversations.updated_at), desc(conversations.id))
    .limit(SCAN);

  if (batch.length === 0) {
    await db
      .insert(dataMigrations)
      .values({ name: CONVERSATION_TITLE_SWEEP_NAME })
      .onConflictDoNothing();
    cursor = null;
    logger.info({
      module: "scheduler",
      action: "conversation_title_sweep.completed",
      msg: "every conversation carries a model-written title",
    });
    return { done: true, scanned: 0, retitled: 0 };
  }
  const ids = batch.map((row) => row.id);
  const messages = await db
    .select({
      conversation_id: conversationMessages.conversation_id,
      content: conversationMessages.content,
    })
    .from(conversationMessages) // tenant-filter:exempt — keyed by the ids above
    .where(
      and(
        inArray(conversationMessages.conversation_id, ids),
        eq(conversationMessages.role, "user"),
      ),
    )
    .orderBy(asc(conversationMessages.created_at));
  const firstUserMessage = new Map<string, unknown>();
  for (const message of messages) {
    if (firstUserMessage.has(message.conversation_id)) continue;
    firstUserMessage.set(message.conversation_id, message.content);
  }

  const refreshTitle = dependencies.refreshTitle ?? refreshConversationTitle;
  let attempted = 0;
  let retitled = 0;
  for (const row of batch) {
    const candidate = isStillOpeningLine(row.title, firstUserMessage.get(row.id));
    if (candidate && attempted >= RETITLE) {
      break;
    }
    if (candidate) {
      attempted += 1;
      const named = await refreshTitle(row.tenant_id, row.id, db);
      if (named) retitled += 1;
    }
    cursor = { updated_at: row.updated_at, id: row.id };
  }

  logger.info({
    module: "scheduler",
    action: "conversation_title_sweep.fired",
    msg: "named dormant conversations",
    scanned: batch.length,
    attempted,
    retitled,
    duration_ms: Date.now() - started,
  });
  return { done: false, scanned: batch.length, retitled };
}

export async function runConversationTitleSweepSafely(db: Db): Promise<void> {
  try {
    await runConversationTitleSweep(db);
  } catch (err) {
    logger.warn({
      module: "scheduler",
      action: "conversation_title_sweep.failed",
      msg: "dormant-conversation titling sweep failed",
      ...errorFields(err),
    });
  }
}
