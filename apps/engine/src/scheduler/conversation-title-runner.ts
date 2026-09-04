// Give dormant conversations a real name.
//
// Auto-titling only fires while a conversation is being used: the model names
// it after the first answer and again every fifth exchange. A conversation
// nobody has touched since therefore keeps the title the boot backfill gave
// it — the first user message, cut mid-sentence. A list of those reads as a
// column of half-sentences that all start the same way, which is the state
// this sweep exists to end.
//
// Why here and not in `db/migrate.ts`: the boot backfill is deliberately
// LLM-free. Model calls in front of the health gate turn a slow or parked
// provider into a failed deploy, and this work is worth exactly nothing if it
// costs availability. On the reconciler tick it is late, cheap and
// interruptible instead.
//
// Order matters more than it looks. Conversation ids are random, so walking
// them in id order visits the estate in no order a reader can perceive: after
// an hour a third of the table is named and the rows a person actually looks
// at — the ones they touched most recently — are as likely to be untouched as
// any other. The walk therefore goes newest-first, by the same column the list
// sorts on, so the improvement shows up where it is being looked for.
//
// Termination without a schema column: a conversation is a candidate only
// while its stored title is still byte-identical to what
// `deriveConversationTitle` produces from its first user message. Naming it
// breaks that equality, so the row stops matching and no marker is needed to
// keep the sweep from redoing its own work. The `data_migrations` marker only
// stops the (cheap, LLM-free) scan once the walk has reached the end.

import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { deriveConversationTitle, refreshConversationTitle } from "../conversations/title.ts";
import type { Db } from "../db/client.ts";
import { conversationMessages, conversations, dataMigrations } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";

export const CONVERSATION_TITLE_SWEEP_NAME = "conversation_title_model_v1";

/** Rows examined per tick. The scan is one indexed select plus one message
 *  lookup; the cost that matters is the model call per match below. */
const SCAN = 100;

/** Model calls per tick. Bounded so a long-dormant estate is renamed over
 *  hours rather than in one burst that competes with live turns for the
 *  provider's rate limit. */
const RETITLE = 10;

/**
 * Whether a stored title is still the opening line the backfill derived, and
 * therefore something the model may rewrite.
 *
 * This is the whole safety rule of the sweep, which is why it is a function
 * with a name rather than a comparison buried in a loop: get it wrong in the
 * permissive direction and an instance-wide job renames conversations a
 * person deliberately titled.
 */
export function isStillOpeningLine(storedTitle: string | null, firstUserMessage: unknown): boolean {
  if (!storedTitle) return false;
  const derived = deriveConversationTitle(firstUserMessage);
  return derived !== null && derived === storedTitle;
}

export interface ConversationTitleSweepReport {
  /** The walk had already reached the end on an earlier tick. */
  done: boolean;
  scanned: number;
  retitled: number;
}

/**
 * Where the walk got to: the last row's sort position, as a pair.
 *
 * `updated_at` alone is not unique, so a keyset cursor needs the id beside it
 * or a batch boundary that lands mid-second silently drops rows. Instance-local
 * on purpose: losing it on restart costs one cheap re-scan, and a row already
 * named no longer matches.
 */
let cursor: { updated_at: Date; id: string } | null = null;

/** Test seam — the walk is otherwise a module-level fold over the table. */
export function resetConversationTitleSweep(): void {
  cursor = null;
}

export async function runConversationTitleSweep(db: Db): Promise<ConversationTitleSweepReport> {
  const marker = await db
    .select({ name: dataMigrations.name })
    .from(dataMigrations) // tenant-filter:exempt — instance-global sweep ledger
    .where(eq(dataMigrations.name, CONVERSATION_TITLE_SWEEP_NAME))
    .limit(1);
  if (marker.length > 0) return { done: true, scanned: 0, retitled: 0 };

  const started = Date.now();
  const conds = [
    isNotNull(conversations.title),
    // A person named it; the sweep has no business overruling that.
    eq(conversations.title_locked, false),
  ];
  if (cursor) {
    conds.push(
      sql`(${conversations.updated_at}, ${conversations.id}) < (${cursor.updated_at}, ${cursor.id})`,
    );
  }

  const batch = await db
    .select({
      id: conversations.id,
      tenant_id: conversations.tenant_id,
      title: conversations.title,
      updated_at: conversations.updated_at,
    })
    .from(conversations) // tenant-filter:exempt — instance-wide maintenance sweep
    .where(and(...conds))
    .orderBy(desc(conversations.updated_at), desc(conversations.id))
    .limit(SCAN);

  if (batch.length === 0) {
    // The walk is over. Record it so later ticks stop scanning entirely.
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
  const lastRow = batch[batch.length - 1];
  cursor = lastRow ? { updated_at: lastRow.updated_at, id: lastRow.id } : null;

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

  let retitled = 0;
  for (const row of batch) {
    if (retitled >= RETITLE) {
      // Leave the cursor on the unfinished part of the batch so the next tick
      // resumes here instead of skipping the rest.
      cursor = { updated_at: row.updated_at, id: row.id };
      break;
    }
    if (!isStillOpeningLine(row.title, firstUserMessage.get(row.id))) continue;
    const named = await refreshConversationTitle(row.tenant_id, row.id, db);
    if (named) retitled += 1;
  }

  logger.info({
    module: "scheduler",
    action: "conversation_title_sweep.fired",
    msg: "named dormant conversations",
    scanned: batch.length,
    retitled,
    duration_ms: Date.now() - started,
  });
  return { done: false, scanned: batch.length, retitled };
}

/** Wrapper for the reconciler: a sweep that cannot name anything must never
 *  take the tick down with it. */
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
