// Embedding backfill — populates the chunk `embedding` columns out-of-band.
//
// Ingest writes chunks without vectors so neither the inline HTTP create
// nor a large ingest blocks on model load + per-chunk inference (FTS is
// available immediately). This pass fills the gap: it scans chunks with a
// NULL embedding, embeds them in batches, and updates the row. It is
// idempotent (the WHERE clause only sees un-embedded rows) and bounded
// (batch size + optional maxBatches), and it stops cleanly when the model
// is unavailable rather than spinning.
//
// Run it as a one-shot over existing data, on a schedule, or triggered
// after an ingest. Title is prepended to the embedded text so the
// highest-signal words survive the model's 512-token truncation.

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { type Executor, getDb } from "../db/client.ts";
import { connectorDocumentChunks } from "../db/schema/connector_docs.ts";
import { conversationMessages, conversations } from "../db/schema/conversations.ts";
import { knowledgeChunks } from "../db/schema/knowledge_sources.ts";
import { log } from "../logging/logger.ts";
import { EMBEDDING_MODEL, embedChunkTextsPaced } from "./local-provider.ts";

/** Extract the user's text from a conversation_messages.content jsonb, which
 *  may be a bare string, a `{ text }` object, or an array of content parts. */
function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === "string"
          ? p
          : p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
            ? (p as { text: string }).text
            : "",
      )
      .filter(Boolean)
      .join(" ");
  }
  if (content && typeof content === "object") {
    const c = content as { text?: unknown; content?: unknown };
    if (typeof c.text === "string") return c.text;
    if (typeof c.content === "string") return c.content;
  }
  return "";
}

// Per-call embedding batch. Kept small on purpose: the in-process WASM
// embedder allocates transformer activations for the whole batch at once and
// its linear-memory arena only grows (never shrinks), so a large batch sets a
// high, permanent RSS water mark. 16 keeps the per-call activation footprint
// modest while still amortising the model call across rows. Within each batch
// the bulk embedding is paced in sub-batches of EMBED_SUBBATCH (see
// embedChunkTextsPaced) so no single synchronous WASM block stalls the event
// loop while a backlog drains.
const BATCH = 16;

export interface BackfillResult {
  scanned: number;
  embedded: number;
}

export interface BackfillOptions {
  tenant_id?: string;
  knowledge_source_id?: string;
  connector_id?: string;
  /** Cap the number of batches (each up to BATCH=16 chunks). Default:
   *  unbounded until no un-embedded chunk remains. */
  maxBatches?: number;
}

function embedInput(title: string | null, content: string): string {
  return [title, content].filter((s): s is string => !!s).join(". ");
}

async function backfillKnowledge(db: Executor, opts: BackfillOptions): Promise<BackfillResult> {
  let scanned = 0;
  let embedded = 0;
  const cap = opts.maxBatches ?? Number.POSITIVE_INFINITY;
  for (let b = 0; b < cap; b++) {
    const rows = await db
      .select({
        id: knowledgeChunks.id,
        title: knowledgeChunks.title,
        content: knowledgeChunks.content,
      })
      .from(knowledgeChunks)
      .where(
        and(
          isNull(knowledgeChunks.embedding),
          opts.tenant_id ? eq(knowledgeChunks.tenant_id, opts.tenant_id) : undefined,
          opts.knowledge_source_id
            ? eq(knowledgeChunks.knowledge_source_id, opts.knowledge_source_id)
            : undefined,
        ),
      )
      .limit(BATCH);
    if (rows.length === 0) break;
    scanned += rows.length;
    const vecs = await embedChunkTextsPaced(rows.map((r) => embedInput(r.title, r.content)));
    if (vecs.every((v) => v === null)) break; // model unavailable — stop, don't spin
    for (let i = 0; i < rows.length; i++) {
      const vec = vecs[i];
      if (!vec) continue;
      await db
        .update(knowledgeChunks)
        .set({ embedding: vec, embedding_model: EMBEDDING_MODEL })
        .where(eq(knowledgeChunks.id, rows[i]!.id));
      embedded++;
    }
  }
  return { scanned, embedded };
}

async function backfillDocs(db: Executor, opts: BackfillOptions): Promise<BackfillResult> {
  let scanned = 0;
  let embedded = 0;
  const cap = opts.maxBatches ?? Number.POSITIVE_INFINITY;
  for (let b = 0; b < cap; b++) {
    const rows = await db
      .select({
        id: connectorDocumentChunks.id,
        title: connectorDocumentChunks.title,
        content: connectorDocumentChunks.content,
      })
      .from(connectorDocumentChunks)
      .where(
        and(
          isNull(connectorDocumentChunks.embedding),
          opts.tenant_id ? eq(connectorDocumentChunks.tenant_id, opts.tenant_id) : undefined,
          opts.connector_id
            ? eq(connectorDocumentChunks.connector_id, opts.connector_id)
            : undefined,
        ),
      )
      .limit(BATCH);
    if (rows.length === 0) break;
    scanned += rows.length;
    const vecs = await embedChunkTextsPaced(rows.map((r) => embedInput(r.title, r.content)));
    if (vecs.every((v) => v === null)) break;
    for (let i = 0; i < rows.length; i++) {
      const vec = vecs[i];
      if (!vec) continue;
      await db
        .update(connectorDocumentChunks)
        .set({ embedding: vec, embedding_model: EMBEDDING_MODEL })
        .where(eq(connectorDocumentChunks.id, rows[i]!.id));
      embedded++;
    }
  }
  return { scanned, embedded };
}

/** Backfill the per-conversation topic embedding (first user message +
 *  title) used by suggest-related-conversations routing. Only scans
 *  conversations that have a user message — the EXISTS guard keeps an empty
 *  conversation from being re-scanned forever (no topic anchor to embed). */
async function backfillConversationTopics(
  db: Executor,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  let scanned = 0;
  let embedded = 0;
  const cap = opts.maxBatches ?? Number.POSITIVE_INFINITY;
  for (let b = 0; b < cap; b++) {
    const convs = await db
      .select({
        id: conversations.id,
        tenant_id: conversations.tenant_id,
        title: conversations.title,
      })
      .from(conversations)
      .where(
        and(
          isNull(conversations.topic_embedding),
          opts.tenant_id ? eq(conversations.tenant_id, opts.tenant_id) : undefined,
          sql`EXISTS (SELECT 1 FROM conversation_messages cm WHERE cm.conversation_id = ${conversations.id} AND cm.role = 'user')`,
        ),
      )
      .limit(BATCH);
    if (convs.length === 0) break;
    scanned += convs.length;
    const texts: string[] = [];
    for (const c of convs) {
      const [first] = await db
        .select({ content: conversationMessages.content })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.tenant_id, c.tenant_id),
            eq(conversationMessages.conversation_id, c.id),
            eq(conversationMessages.role, "user"),
          ),
        )
        .orderBy(asc(conversationMessages.created_at))
        .limit(1);
      texts.push(embedInput(c.title, extractMessageText(first?.content)));
    }
    const vecs = await embedChunkTextsPaced(texts);
    if (vecs.every((v) => v === null)) break;
    for (let i = 0; i < convs.length; i++) {
      const vec = vecs[i];
      if (!vec) continue;
      await db
        .update(conversations)
        .set({ topic_embedding: vec, topic_embedding_model: EMBEDDING_MODEL })
        .where(eq(conversations.id, convs[i]!.id));
      embedded++;
    }
  }
  return { scanned, embedded };
}

/** Backfill embeddings for knowledge + connector-doc chunks AND
 *  conversation topics. Returns per-target counts. Best-effort: when the
 *  model is unavailable every target reports what it scanned with
 *  `embedded: 0`. */
export async function backfillEmbeddings(
  opts: BackfillOptions = {},
  exec?: Executor,
): Promise<{ knowledge: BackfillResult; docs: BackfillResult; conversations: BackfillResult }> {
  const db = exec ?? getDb();
  const knowledge = await backfillKnowledge(db, opts);
  const docs = await backfillDocs(db, opts);
  const convTopics = await backfillConversationTopics(db, opts);
  log.info({
    module: "embeddings",
    action: "backfill.completed",
    msg: "embedding backfill finished",
    knowledge_embedded: knowledge.embedded,
    knowledge_scanned: knowledge.scanned,
    docs_embedded: docs.embedded,
    docs_scanned: docs.scanned,
    conversations_embedded: convTopics.embedded,
    conversations_scanned: convTopics.scanned,
  });
  return { knowledge, docs, conversations: convTopics };
}
